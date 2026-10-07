import type Stripe from "stripe";
import type { ConnectDebitPayment, ConnectDebitProvider } from "./fee-connect.service.js";
import { ConnectDebitInsufficientBalanceError } from "./fee-connect.service.js";
import { stripeEvidenceId } from "./fee-stripe-evidence.js";

export function createPinAIConnectStripeProvider(stripe: Stripe): ConnectDebitProvider {
  const payment = (value: Stripe.Charge): ConnectDebitPayment => {
    if (!["charge", "payment"].includes(value.object as string) || !value.id.startsWith("py_"))
      throw new Error("CONNECT_PAYMENT_REQUIRED");
    return { id: value.id, accountId: stripeEvidenceId(value.source) ?? "", amount: value.amount,
      currency: value.currency, paid: value.paid, status: value.status, metadata: value.metadata ?? {} };
  };
  return {
    eligibility: async accountId => {
      const [platform, account] = await Promise.all([stripe.accounts.retrieve(), stripe.accounts.retrieve(accountId)]);
      // V1 supports the certified US/USD corridor only. Fail closed elsewhere.
      const compatible = platform.country === "US" && account.country === "US" &&
        account.default_currency === "usd" && account.controller?.losses?.payments === "application";
      if (!compatible) return { compatible: false, availableCents: 0 };
      const balance = await stripe.balance.retrieve({}, { stripeAccount: accountId });
      return { compatible, availableCents: balance.available.filter(v => v.currency === "usd")
        .reduce((sum, v) => sum + v.amount, 0) };
    },
    create: async (fee, key) => { try { return payment(await stripe.charges.create({
      amount: fee.amountCents, currency: "usd", source: fee.stripeConnectedAccountId!,
      description: `Pin AI · Reserva ${fee.reservationId} · USD 1.00`,
      metadata: { pinAIReservationId: fee.reservationId, organizationId: fee.organizationId,
        propertyId: fee.propertyId, pinAITermsVersion: fee.termsVersion },
    }, { idempotencyKey: key })); // Platform context; no Stripe-Account header.
    } catch (error) {
      const e = error as { code?: string; type?: string };
      if (e.type === "StripeInvalidRequestError" && e.code === "balance_insufficient")
        throw new ConnectDebitInsufficientBalanceError();
      throw error;
    } },
    retrieve: async paymentId => payment(await stripe.charges.retrieve(paymentId)),
    reconcile: async (fee, now) => {
      if (!fee.debitStartedAt) throw new Error("CONNECT_ATTEMPT_TIME_REQUIRED");
      const payments: ConnectDebitPayment[] = [];
      const seen = new Set<string>();
      let cursor: string | undefined;
      let reads = 0;
      // Platform balance history includes Account Debit Payments. Bounded,
      // paginated read-only scan; a truncated result cannot prove uniqueness.
      for (let page = 0; page < 5; page++) {
        const result = await stripe.balanceTransactions.list({ type: "payment", currency: "usd", limit: 100,
          created: { gte: Math.floor(+fee.debitStartedAt / 1000) - 60, lte: Math.ceil(+now / 1000) + 60 },
          ...(cursor ? { starting_after: cursor } : {}) });
        for (const transaction of result.data) {
          const id = stripeEvidenceId(transaction.source);
          if (!id?.startsWith("py_") || seen.has(id)) continue;
          seen.add(id);
          if (++reads > 20) return { payments, complete: false };
          const candidate = payment(await stripe.charges.retrieve(id));
          if (candidate.metadata.pinAIReservationId === fee.reservationId) payments.push(candidate);
        }
        if (!result.has_more) return { payments, complete: true };
        const next = result.data.at(-1)?.id;
        if (!next || next === cursor) return { payments, complete: false };
        cursor = next;
      }
      return { payments, complete: false };
    },
  };
}
