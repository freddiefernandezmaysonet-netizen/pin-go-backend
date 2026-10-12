import assert from "node:assert/strict";
import type Stripe from "stripe";
import { createHybridFeeStripeProvider } from "../pin-ai/hybrid-fee-stripe.provider.js";
import { PIN_AI_HYBRID_BILLING_TERMS as TERMS } from "../pin-ai/billing-terms.js";
import type { PinAIReservationFee } from "@prisma/client";

export const HYBRID_SANDBOX_PLATFORM = "acct_1SmdRdRzkK1jKKf3";
export async function certifyPinAIMembershipSandbox(stripe: Stripe, run: string,
  report: (data: Record<string, unknown>) => void) {
  const platform = await stripe.accounts.retrieve();
  assert.equal(platform.id, HYBRID_SANDBOX_PLATFORM, "SANDBOX_ACCOUNT_MISMATCH");
  assert.match(run, /^qa-pin-ai-hybrid-[a-f0-9-]{36}$/);
  const key = (stage: string) => `${run}:${stage}`;
  const metadata = { synthetic: "true", pinAIHybridCertification: run };
  const owner = await stripe.customers.create({ name: "Synthetic Pin AI hybrid certification", metadata },
    { idempotencyKey: key("guard") });
  assert.equal(owner.livemode, false);
  const persisted = await stripe.customers.retrieve(owner.id);
  assert.ok(!("deleted" in persisted && persisted.deleted));
  if ((persisted as Stripe.Customer).metadata.state) throw Error("CERTIFICATION_ALREADY_ATTEMPTED");
  await stripe.customers.update(owner.id, { metadata: { state: "ATTEMPTED" } });
  report({ stage: "GUARD", customerId: owner.id, run, livemode: false });
  const provider = createHybridFeeStripeProvider(stripe);
  const receipts: Record<string, unknown>[] = [];
  const subscriptions: string[] = [], invoices: string[] = [];
  let priceId: string | null = null, productId: string | null = null;
  try {
    const price = await stripe.prices.create({ currency: "usd", unit_amount: 0,
      recurring: { interval: "month" }, product_data: { name: "Synthetic membership for Pin AI certification", metadata }, metadata },
    { idempotencyKey: key("membership-price") });
    priceId = price.id; productId = typeof price.product === "string" ? price.product : price.product.id;
    for (const state of ["PENDING", "DRAFT", "OPEN", "PAID"] as const) {
      const customer = await stripe.customers.create({ name: "Synthetic Pin AI membership", metadata },
        { idempotencyKey: key(`customer:${state}`) });
      assert.equal(customer.livemode, false);
      const sub = await stripe.subscriptions.create({ customer: customer.id, items: [{ price: price.id }],
        collection_method: "charge_automatically", metadata: { ...metadata, organizationId: run } },
      { idempotencyKey: key(`subscription:${state}`) });
      subscriptions.push(sub.id);
      assert.equal(sub.livemode, false);
      assert.equal(await provider.validateMembership(customer.id, sub.id, run), true);
      const fee = { reservationId: `${run}:membership:${state}`, organizationId: run, propertyId: "synthetic-property",
        amountCents: 100, currency: "USD", termsVersion: TERMS.version, collectionMethod: "MEMBERSHIP",
        stripeCustomerId: customer.id, stripeSubscriptionId: sub.id, stripeInvoiceItemId: null } as PinAIReservationFee;
      const itemKey = key(`item:${state}`);
      const item = await provider.createItem(fee, itemKey); fee.stripeInvoiceItemId = item.id;
      assert.equal((await provider.createItem(fee, itemKey)).id, item.id);
      assert.equal(await provider.reconcile(fee, "ITEM", itemKey), item.id);
      let invoiceId: string | null = null;
      if (state !== "PENDING") {
        const invoice = await stripe.invoices.create({ customer: customer.id, subscription: sub.id,
          auto_advance: false, collection_method: "charge_automatically",
          metadata }, { idempotencyKey: key(`invoice:${state}`) });
        invoiceId = invoice.id; invoices.push(invoice.id);
        assert.equal(invoice.livemode, false); assert.equal(invoice.total, 100);
        if (state !== "DRAFT") await stripe.invoices.finalizeInvoice(invoice.id, { auto_advance: false });
        if (state === "PAID") {
          const method = await stripe.paymentMethods.create({ type: "card", card: { token: "tok_visa" }, metadata },
            { idempotencyKey: key(`card:${state}`) });
          assert.equal(method.livemode, false);
          await stripe.paymentMethods.attach(method.id, { customer: customer.id });
          const paid = await stripe.invoices.pay(invoice.id, { payment_method: method.id }, { idempotencyKey: key(`pay:${state}`) });
          assert.equal(paid.status, "paid"); assert.equal(paid.amount_paid, 100);
          assert.equal((await provider.itemState(fee)).paid, true);
        }
      }
      const reversal = await provider.reversalPlan(fee);
      const reversalId = await provider.reverse(fee, reversal, key(`reversal:${state}`));
      assert.equal(await provider.reverse(fee, reversal, key(`reversal:${state}`)), reversalId);
      if (state === "PENDING" || state === "DRAFT") {
        await assert.rejects(stripe.invoiceItems.retrieve(item.id), (e: unknown) => (e as { code?: string }).code === "resource_missing");
      } else {
        const note = await stripe.creditNotes.retrieve(reversalId); assert.equal(note.livemode, false); assert.equal(note.amount, 100);
        const invoice = await stripe.invoices.retrieve(invoiceId!); assert.equal(invoice.amount_remaining, 0);
        if (state === "PAID") {
          const credited = await stripe.customers.retrieve(customer.id) as Stripe.Customer;
          assert.equal(credited.balance, -100, "Paid membership fee must become exact host credit");
        }
      }
      const receipt = { case: "MEMBERSHIP", state, customerId: customer.id, subscriptionId: sub.id,
        invoiceItemId: item.id, invoiceId, reversalId, amountCents: 100, netPinAIFeeCents: 0, sameItemOnRetry: true,
        sameReversalOnRetry: true };
      receipts.push(receipt); report(receipt);
    }
    await stripe.customers.update(owner.id, { metadata: { state: "CERTIFIED" } });
    return { certified: true, run, platform: platform.id, livemode: false,
      sdk: "14.25.0", apiVersion: "2023-10-16", receipts,
      certificationScope: "REAL_MEMBERSHIP_STRIPE_PROVIDER; POSTGRES_CERTIFIED_SEPARATELY; DIRECT_BOOKING_NOT_EXERCISED; HTTP_WEBHOOK_NOT_EXERCISED" };
  } finally {
    for (const invoiceId of invoices) {
      try { const invoice = await stripe.invoices.retrieve(invoiceId);
        if (invoice.status === "draft") {
          try { await stripe.invoices.del(invoiceId); }
          catch {
            const finalized = await stripe.invoices.finalizeInvoice(invoiceId, { auto_advance: false });
            if (finalized.status === "open") await stripe.invoices.voidInvoice(invoiceId);
          }
        } else if (invoice.status === "open") await stripe.invoices.voidInvoice(invoiceId);
      } catch { report({ cleanupPending: "invoice", invoiceId }); }
    }
    for (const id of subscriptions) {
      try { await stripe.subscriptions.cancel(id, { prorate: false, invoice_now: false }); }
      catch { report({ cleanupPending: "subscription", subscriptionId: id }); }
    }
    if (productId) try { await stripe.products.update(productId, { active: false }); } catch { report({ cleanupPending: "product", productId }); }
    if (priceId) try { await stripe.prices.update(priceId, { active: false }); } catch { report({ cleanupPending: "price", priceId }); }
    report({ cleanup: "RECURRING_BILLING_STOPPED", scope: "MEMBERSHIP_ONLY" });
  }
}
