import type Stripe from "stripe";
import type { PinAIReservationFee } from "@prisma/client";
export type ReversalRequest = { kind: "DELETE_ITEM"; itemId: string } |
  { kind: "CREDIT_NOTE"; invoiceId: string; lineId: string; creditAmount: number } |
  { kind: "APPLICATION_FEE_REFUND"; feeId: string; amount: number; target: number } |
  { kind: "NONE" };
export type HybridFeeProvider = {
  validateMembership(customerId: string, subscriptionId: string, organizationId: string): Promise<boolean>;
  createItem(fee: PinAIReservationFee, key: string): Promise<{ id: string }>;
  itemState(fee: PinAIReservationFee): Promise<{ invoiceId: string | null; paid: boolean }>;
  directEvidence(fee: PinAIReservationFee): Promise<string>;
  reversalPlan(fee: PinAIReservationFee): Promise<ReversalRequest>;
  reverse(fee: PinAIReservationFee, request: ReversalRequest, key: string): Promise<string>;
  reconcile(fee: PinAIReservationFee, operation: "ITEM" | "REVERSAL", key: string): Promise<string | null>;
};
const id = (value: unknown): string | null => typeof value === "string" ? value :
  value && typeof value === "object" && "id" in value ? String(value.id) : null;
const meta = (fee: PinAIReservationFee, key?: string) => ({ pinAIReservationId: fee.reservationId,
  organizationId: fee.organizationId, propertyId: fee.propertyId, pinAITermsVersion: fee.termsVersion,
  ...(key ? { pinAIOperationKey: key } : {}) });
export function createHybridFeeStripeProvider(stripe: Stripe): HybridFeeProvider {
  async function appFee(fee: PinAIReservationFee) {
    if (!fee.stripePaymentIntentId || !fee.stripeConnectedAccountId) throw Error("DIRECT_SCOPE_MISSING");
    const pi = await stripe.paymentIntents.retrieve(fee.stripePaymentIntentId,
      { expand: ["latest_charge"] }, { stripeAccount: fee.stripeConnectedAccountId });
    const charge = pi.latest_charge as Stripe.Charge | null;
    const feeId = id(charge?.application_fee);
    if (pi.status !== "succeeded" || !charge || typeof charge === "string" || !charge.paid || !feeId ||
      !pi.application_fee_amount || pi.application_fee_amount < 100 ||
      pi.metadata.pinAIFeeAmountCents !== "100" || pi.metadata.pinAITermsVersion !== fee.termsVersion ||
      pi.metadata.propertyId !== fee.propertyId || pi.metadata.organizationId !== fee.organizationId) throw Error("DIRECT_PAYMENT_NOT_VERIFIED");
    const applicationFee = await stripe.applicationFees.retrieve(feeId);
    if (id(applicationFee.account) !== fee.stripeConnectedAccountId || id(applicationFee.charge) !== charge.id ||
      applicationFee.currency !== "usd" || applicationFee.amount < 100 ||
      (fee.stripeApplicationFeeId && fee.stripeApplicationFeeId !== applicationFee.id)) throw Error("DIRECT_FEE_SCOPE_MISMATCH");
    return { applicationFee, charge };
  }
  async function invoiceItem(fee: PinAIReservationFee) {
    const item = await stripe.invoiceItems.retrieve(fee.stripeInvoiceItemId!);
    if (id(item.customer) !== fee.stripeCustomerId || id(item.subscription) !== fee.stripeSubscriptionId ||
      item.amount !== 100 || item.currency !== "usd" || item.metadata?.pinAIReservationId !== fee.reservationId ||
      item.metadata?.organizationId !== fee.organizationId || item.metadata?.propertyId !== fee.propertyId ||
      item.metadata?.pinAITermsVersion !== fee.termsVersion) throw Error("INVOICE_ITEM_SCOPE_MISMATCH");
    return item;
  }
  return {
    async validateMembership(customerId, subscriptionId, organizationId) {
      const sub = await stripe.subscriptions.retrieve(subscriptionId);
      return id(sub.customer) === customerId && sub.metadata.organizationId === organizationId &&
        ["active", "trialing", "past_due"].includes(sub.status) && sub.currency === "usd";
    },
    async createItem(fee, key) {
      return stripe.invoiceItems.create({ customer: fee.stripeCustomerId!, subscription: fee.stripeSubscriptionId!,
        amount: 100, currency: "usd", discountable: false, tax_rates: [],
        description: `Pin AI · reservation ${fee.reservationId}`, metadata: meta(fee, key) }, { idempotencyKey: key });
    },
    async itemState(fee) {
      const item = await invoiceItem(fee); const invoiceId = id(item.invoice);
      if (!invoiceId) return { invoiceId: null, paid: false };
      const invoice = await stripe.invoices.retrieve(invoiceId);
      if (id(invoice.customer) !== fee.stripeCustomerId || id(invoice.subscription) !== fee.stripeSubscriptionId)
        throw Error("INVOICE_SCOPE_MISMATCH");
      return { invoiceId, paid: invoice.status === "paid" };
    },
    async directEvidence(fee) { return (await appFee(fee)).applicationFee.id; },
    async reversalPlan(fee) {
      if (fee.collectionMethod === "DIRECT_APPLICATION_FEE") {
        const { applicationFee, charge } = await appFee(fee);
        // Pin AI is fully returned. The existing commission is returned in the
        // same proportion as the guest payment, without double-refunding it.
        const target = Math.min(applicationFee.amount, 100 + Math.round((applicationFee.amount - 100) *
          charge.amount_refunded / charge.amount));
        const amount = Math.max(0, target - applicationFee.amount_refunded);
        return amount ? { kind: "APPLICATION_FEE_REFUND", feeId: applicationFee.id, amount, target } : { kind: "NONE" };
      }
      const item = await invoiceItem(fee); const invoiceId = id(item.invoice);
      if (!invoiceId) return { kind: "DELETE_ITEM", itemId: item.id };
      const invoice = await stripe.invoices.retrieve(invoiceId);
      if (id(invoice.customer) !== fee.stripeCustomerId || id(invoice.subscription) !== fee.stripeSubscriptionId)
        throw Error("INVOICE_SCOPE_MISMATCH");
      if (invoice.status === "draft") return { kind: "DELETE_ITEM", itemId: item.id };
      if (invoice.status === "void") return { kind: "NONE" };
      let lineId: string | null = null;
      for await (const line of stripe.invoices.listLineItems(invoiceId, { limit: 100 })) {
        if (id(line.invoice_item) === item.id) { lineId = line.id; break; }
      }
      if (!lineId) throw Error("INVOICE_LINE_NOT_FOUND");
      const preview = await stripe.creditNotes.preview({ invoice: invoiceId,
        lines: [{ type: "invoice_line_item", invoice_line_item: lineId, amount: 100 }] });
      return { kind: "CREDIT_NOTE", invoiceId, lineId, creditAmount: Math.max(0, preview.amount - invoice.amount_remaining) };
    },
    async reverse(fee, request, key) {
      if (request.kind === "NONE") return "NO_COLLECTION";
      if (request.kind === "DELETE_ITEM") {
        try { await stripe.invoiceItems.del(request.itemId, { idempotencyKey: key }); }
        catch (e) {
          // A lost DELETE response is safe to recover from its absence.
          if ((e as { code?: string }).code !== "resource_missing") {
            if ((e as { type?: string }).type === "StripeInvalidRequestError") throw Error("HYBRID_REVERSAL_REJECTED");
            throw e;
          }
        }
        return `deleted:${request.itemId}`;
      }
      if (request.kind === "APPLICATION_FEE_REFUND") {
        return (await stripe.applicationFees.createRefund(request.feeId, { amount: request.amount,
          metadata: meta(fee, key) }, { idempotencyKey: key })).id;
      }
      try {
        return (await stripe.creditNotes.create({ invoice: request.invoiceId,
          lines: [{ type: "invoice_line_item", invoice_line_item: request.lineId, amount: 100 }],
          credit_amount: request.creditAmount, memo: "Cancelled reservation · Pin AI fee reversal",
          metadata: meta(fee, key) }, { idempotencyKey: key })).id;
      } catch (e) {
        if ((e as { type?: string }).type === "StripeInvalidRequestError") throw Error("HYBRID_REVERSAL_REJECTED");
        throw e;
      }
    },
    async reconcile(fee, operation, key) {
      const matches: string[] = [];
      if (operation === "ITEM") {
        for await (const item of stripe.invoiceItems.list({ customer: fee.stripeCustomerId!, limit: 100 })) {
          if (item.metadata?.pinAIOperationKey === key) matches.push(item.id);
        }
      } else {
        const request = fee.reversalRequest as ReversalRequest | null;
        if (request?.kind === "DELETE_ITEM") {
          try { await stripe.invoiceItems.retrieve(request.itemId); }
          catch (e) { if ((e as { code?: string }).code === "resource_missing") return `deleted:${request.itemId}`; throw e; }
        } else if (request?.kind === "APPLICATION_FEE_REFUND") {
          for await (const refund of stripe.applicationFees.listRefunds(request.feeId, { limit: 100 })) {
            if (refund.metadata?.pinAIOperationKey === key) matches.push(refund.id);
          }
        } else if (request?.kind === "CREDIT_NOTE") {
          for await (const note of stripe.creditNotes.list({ invoice: request.invoiceId, limit: 100 })) {
            if (note.metadata?.pinAIOperationKey === key && note.status !== "void") matches.push(note.id);
          }
        }
      }
      if (matches.length > 1) throw Error("MULTIPLE_BILLING_OPERATIONS");
      return matches[0] ?? null;
    },
  };
}
