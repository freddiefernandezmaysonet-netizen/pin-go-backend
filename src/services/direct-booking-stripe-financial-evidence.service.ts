import type Stripe from "stripe";

export type DirectBookingStripeFinancialEvidence = {
  stripeChargeId: string | null;
  stripeTransferId: string | null;
  stripeApplicationFeeId: string | null;
  stripeBalanceTransactionId: string | null;
  stripeProcessingFeeAmountCents: number | null;
  applicationFeeAmountCents: number | null;
  hostNetAmountCents: number | null;
  balanceCurrency: string | null;
};

function objectId(value: unknown) {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "id" in value) {
    return String((value as { id?: unknown }).id ?? "").trim() || null;
  }
  return null;
}

function normalizeCents(value: unknown) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) && numberValue >= 0
    ? Math.round(numberValue)
    : null;
}

export function extractDirectBookingStripeFinancialEvidence(
  paymentIntent: Stripe.PaymentIntent
): DirectBookingStripeFinancialEvidence {
  const emptyEvidence: DirectBookingStripeFinancialEvidence = {
    stripeChargeId: null,
    stripeTransferId: null,
    stripeApplicationFeeId: null,
    stripeBalanceTransactionId: null,
    stripeProcessingFeeAmountCents: null,
    applicationFeeAmountCents: normalizeCents(
      paymentIntent.application_fee_amount
    ),
    hostNetAmountCents: null,
    balanceCurrency: null,
  };

  const latestCharge = paymentIntent.latest_charge;

  if (!latestCharge) {
    return emptyEvidence;
  }

  if (typeof latestCharge === "string") {
    return {
      ...emptyEvidence,
      stripeChargeId: latestCharge,
    };
  }

  const charge = latestCharge as Stripe.Charge;
  const chargeAny = charge as any;
  const applicationFeeAmountCents =
    normalizeCents(paymentIntent.application_fee_amount) ?? 0;
  const balanceTransaction = chargeAny.balance_transaction;
  const balanceTransactionId = objectId(balanceTransaction);

  const commonEvidence = {
    ...emptyEvidence,
    stripeChargeId: charge.id ?? null,
    stripeTransferId: objectId(chargeAny.transfer),
    stripeApplicationFeeId: objectId(chargeAny.application_fee),
    stripeBalanceTransactionId: balanceTransactionId,
    applicationFeeAmountCents,
  };

  if (
    !balanceTransaction ||
    typeof balanceTransaction === "string" ||
    balanceTransaction.object !== "balance_transaction"
  ) {
    return commonEvidence;
  }

  const totalFeeCents = normalizeCents(balanceTransaction.fee);
  const netCents = Number(balanceTransaction.net);
  const stripeProcessingFeeAmountCents =
    totalFeeCents === null
      ? null
      : Math.max(0, totalFeeCents - applicationFeeAmountCents);

  return {
    ...commonEvidence,
    stripeProcessingFeeAmountCents,
    hostNetAmountCents: Number.isFinite(netCents)
      ? Math.max(0, Math.round(netCents))
      : null,
    balanceCurrency:
      String(balanceTransaction.currency ?? "").trim().toLowerCase() || null,
  };
}
