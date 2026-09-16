import type Stripe from "stripe";
import { retrieveDirectBookingPaymentIntent } from "./direct-booking-stripe-resource-context.service.js";

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

type ReservationFinancialRepository = {
  findUnique: (args: any) => Promise<any>;
  update: (args: any) => Promise<any>;
};

type StripePaymentIntentClient = Parameters<
  typeof retrieveDirectBookingPaymentIntent
>[0]["stripeClient"];

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

function asRecord(value: unknown): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return { ...(value as Record<string, any>) };
}

function centsToMoney(value: number | null) {
  return value === null ? null : Number((value / 100).toFixed(2));
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

export async function reconcileDirectBookingDirectChargeFinancialEvidence(input: {
  reservationRepository: ReservationFinancialRepository;
  stripeClient: StripePaymentIntentClient;
  event: Stripe.Event;
  now?: Date;
}) {
  if (input.event.type !== "checkout.session.completed") {
    return {
      handled: false as const,
      reason: "EVENT_TYPE_NOT_SUPPORTED" as const,
    };
  }

  const session = input.event.data.object as Stripe.Checkout.Session;
  const flow = String(session.metadata?.flow ?? "").trim();
  const stripeChargeMode = String(
    session.metadata?.stripeChargeMode ?? ""
  ).trim();

  if (flow !== "direct_booking") {
    return {
      handled: false as const,
      reason: "FLOW_NOT_DIRECT_BOOKING" as const,
    };
  }

  if (stripeChargeMode !== "DIRECT_CHARGE") {
    return {
      handled: false as const,
      reason: "NOT_DIRECT_CHARGE" as const,
    };
  }

  const reservation = await input.reservationRepository.findUnique({
    where: {
      stripeCheckoutSessionId: session.id,
    },
    select: {
      id: true,
      stripePaymentIntentId: true,
      stripeConnectedAccountId: true,
      stripeChargeId: true,
      stripeTransferId: true,
      stripeApplicationFeeId: true,
      hostPayoutAmount: true,
      externalRaw: true,
    },
  });

  if (!reservation) {
    throw new Error(
      "DIRECT_BOOKING_STRIPE_FINANCIAL_RECONCILIATION_RESERVATION_NOT_FOUND"
    );
  }

  const paymentIntentId =
    String(reservation.stripePaymentIntentId ?? "").trim() ||
    objectId(session.payment_intent);

  if (!paymentIntentId) {
    throw new Error(
      "DIRECT_BOOKING_STRIPE_FINANCIAL_RECONCILIATION_PAYMENT_INTENT_MISSING"
    );
  }

  const eventConnectedAccountId = String(
    (input.event as any).account ?? ""
  ).trim();
  const reservationConnectedAccountId = String(
    reservation.stripeConnectedAccountId ?? ""
  ).trim();
  const metadataConnectedAccountId = String(
    session.metadata?.stripeConnectedAccountId ?? ""
  ).trim();
  const connectedAccountId = eventConnectedAccountId.startsWith("acct_")
    ? eventConnectedAccountId
    : reservationConnectedAccountId.startsWith("acct_")
      ? reservationConnectedAccountId
      : metadataConnectedAccountId.startsWith("acct_")
        ? metadataConnectedAccountId
        : null;

  if (!connectedAccountId) {
    throw new Error(
      "DIRECT_BOOKING_STRIPE_FINANCIAL_RECONCILIATION_CONNECTED_ACCOUNT_MISSING"
    );
  }

  const paymentIntentResult = await retrieveDirectBookingPaymentIntent({
    stripeClient: input.stripeClient,
    paymentIntentId,
    connectedAccountId,
    params: {
      expand: [
        "latest_charge",
        "latest_charge.transfer",
        "latest_charge.application_fee",
        "latest_charge.balance_transaction",
      ],
    },
  });

  if (paymentIntentResult.chargeMode !== "DIRECT_CHARGE") {
    throw new Error(
      "DIRECT_BOOKING_STRIPE_FINANCIAL_RECONCILIATION_CHARGE_MODE_MISMATCH"
    );
  }

  const evidence = extractDirectBookingStripeFinancialEvidence(
    paymentIntentResult.paymentIntent
  );
  const reconciledAt = input.now ?? new Date();
  const previousExternalRaw = asRecord(reservation.externalRaw);
  const stripeFinancialEvidence = {
    chargeMode: paymentIntentResult.chargeMode,
    stripeAccount: paymentIntentResult.stripeAccount,
    stripeChargeId: evidence.stripeChargeId,
    stripeTransferId: evidence.stripeTransferId,
    stripeApplicationFeeId: evidence.stripeApplicationFeeId,
    stripeBalanceTransactionId: evidence.stripeBalanceTransactionId,
    stripeProcessingFeeAmountCents: evidence.stripeProcessingFeeAmountCents,
    stripeProcessingFeeAmount: centsToMoney(
      evidence.stripeProcessingFeeAmountCents
    ),
    applicationFeeAmountCents: evidence.applicationFeeAmountCents,
    applicationFeeAmount: centsToMoney(evidence.applicationFeeAmountCents),
    hostNetAmountCents: evidence.hostNetAmountCents,
    hostNetAmount: centsToMoney(evidence.hostNetAmountCents),
    balanceCurrency: evidence.balanceCurrency,
    reconciledAt: reconciledAt.toISOString(),
    source: "STRIPE_BALANCE_TRANSACTION",
  };

  const updateData: Record<string, any> = {
    stripeChargeId:
      evidence.stripeChargeId ?? reservation.stripeChargeId ?? undefined,
    stripeTransferId:
      evidence.stripeTransferId ?? reservation.stripeTransferId ?? undefined,
    stripeApplicationFeeId:
      evidence.stripeApplicationFeeId ??
      reservation.stripeApplicationFeeId ??
      undefined,
    hostPayoutLastSyncedAt: reconciledAt,
    externalRaw: {
      ...previousExternalRaw,
      stripeFinancialEvidence,
    },
  };

  if (evidence.hostNetAmountCents !== null) {
    updateData.hostPayoutAmount = centsToMoney(evidence.hostNetAmountCents);
  }

  await input.reservationRepository.update({
    where: {
      id: reservation.id,
    },
    data: updateData,
  });

  return {
    handled: true as const,
    reservationId: reservation.id,
    paymentIntentId,
    connectedAccountId,
    chargeMode: paymentIntentResult.chargeMode,
    stripeProcessingFeeAmountCents: evidence.stripeProcessingFeeAmountCents,
    hostNetAmountCents: evidence.hostNetAmountCents,
    stripeBalanceTransactionId: evidence.stripeBalanceTransactionId,
  };
}
