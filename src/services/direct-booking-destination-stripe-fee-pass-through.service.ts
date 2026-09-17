import type Stripe from "stripe";

export type DirectBookingDestinationStripeFeeEvidence = {
  stripeChargeId: string;
  stripeTransferId: string;
  stripeApplicationFeeId: string | null;
  stripeBalanceTransactionId: string;
  stripeProcessingFeeAmountCents: number;
  applicationFeeAmountCents: number;
  hostNetAmountCents: number;
  balanceCurrency: string;
  transferReversalId: string;
  transferReversalAmountCents: number;
};

type ReservationFinancialRepository = {
  findUnique: (args: any) => Promise<any>;
  update: (args: any) => Promise<any>;
};

type DestinationFeePassThroughStripeClient = Pick<
  Stripe,
  "paymentIntents" | "transfers"
>;

function objectId(value: unknown) {
  if (typeof value === "string") {
    return value.trim() || null;
  }

  if (value && typeof value === "object" && "id" in value) {
    return String((value as { id?: unknown }).id ?? "").trim() || null;
  }

  return null;
}

function asRecord(value: unknown): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return { ...(value as Record<string, any>) };
}

function normalizeCents(value: unknown) {
  const parsed = Number(value);

  return Number.isFinite(parsed) && parsed >= 0
    ? Math.round(parsed)
    : null;
}

function centsToMoney(value: number) {
  return Number((Math.max(0, Math.round(value)) / 100).toFixed(2));
}

function isDirectBookingDestinationCheckoutEvent(event: Stripe.Event) {
  if (event.type !== "checkout.session.completed") {
    return false;
  }

  const session = event.data.object as Stripe.Checkout.Session;
  const flow = String(session.metadata?.flow ?? "").trim();
  const chargeMode = String(
    session.metadata?.stripeChargeMode ?? "DESTINATION_CHARGE"
  ).trim();

  return flow === "direct_booking" && chargeMode !== "DIRECT_CHARGE";
}

export async function recoverDirectBookingDestinationStripeProcessingFee(input: {
  reservationRepository: ReservationFinancialRepository;
  stripeClient: DestinationFeePassThroughStripeClient;
  event: Stripe.Event;
  now?: Date;
}) {
  if (!isDirectBookingDestinationCheckoutEvent(input.event)) {
    return {
      handled: false as const,
      reason: "NOT_DESTINATION_DIRECT_BOOKING" as const,
    };
  }

  const session = input.event.data.object as Stripe.Checkout.Session;
  const reservation = await input.reservationRepository.findUnique({
    where: {
      stripeCheckoutSessionId: session.id,
    },
    select: {
      id: true,
      stripePaymentIntentId: true,
      stripeChargeId: true,
      stripeTransferId: true,
      stripeApplicationFeeId: true,
      hostPayoutAmount: true,
      externalRaw: true,
    },
  });

  if (!reservation) {
    throw new Error(
      "DIRECT_BOOKING_DESTINATION_FEE_RECOVERY_RESERVATION_NOT_FOUND"
    );
  }

  const previousExternalRaw = asRecord(reservation.externalRaw);
  const previousFinancialEvidence = asRecord(
    previousExternalRaw.stripeFinancialEvidence
  );
  const previousRecovery = asRecord(
    previousFinancialEvidence.processingFeeRecovery
  );

  if (
    previousFinancialEvidence.chargeMode === "DESTINATION_CHARGE" &&
    previousFinancialEvidence.source ===
      "STRIPE_BALANCE_TRANSACTION_AND_TRANSFER_REVERSAL" &&
    previousRecovery.status === "RECOVERED" &&
    String(previousRecovery.transferReversalId ?? "").startsWith("trr_")
  ) {
    return {
      handled: true as const,
      idempotentReplay: true as const,
      reservationId: reservation.id,
      stripeProcessingFeeAmountCents:
        normalizeCents(
          previousFinancialEvidence.stripeProcessingFeeAmountCents
        ) ?? 0,
      hostNetAmountCents:
        normalizeCents(previousFinancialEvidence.hostNetAmountCents) ?? null,
      transferReversalId: String(previousRecovery.transferReversalId),
    };
  }

  const paymentIntentId =
    String(reservation.stripePaymentIntentId ?? "").trim() ||
    objectId(session.payment_intent);

  if (!paymentIntentId) {
    throw new Error(
      "DIRECT_BOOKING_DESTINATION_FEE_RECOVERY_PAYMENT_INTENT_MISSING"
    );
  }

  const paymentIntent = await input.stripeClient.paymentIntents.retrieve(
    paymentIntentId,
    {
      expand: [
        "latest_charge",
        "latest_charge.transfer",
        "latest_charge.application_fee",
        "latest_charge.balance_transaction",
      ],
    }
  );

  const latestCharge = paymentIntent.latest_charge;

  if (!latestCharge || typeof latestCharge === "string") {
    throw new Error(
      "DIRECT_BOOKING_DESTINATION_FEE_RECOVERY_CHARGE_NOT_EXPANDED"
    );
  }

  const charge = latestCharge as Stripe.Charge;
  const chargeAny = charge as any;
  const balanceTransaction = chargeAny.balance_transaction;

  if (
    !balanceTransaction ||
    typeof balanceTransaction === "string" ||
    balanceTransaction.object !== "balance_transaction"
  ) {
    throw new Error(
      "DIRECT_BOOKING_DESTINATION_FEE_RECOVERY_BALANCE_TRANSACTION_NOT_EXPANDED"
    );
  }

  const stripeProcessingFeeAmountCents = normalizeCents(
    balanceTransaction.fee
  );

  if (stripeProcessingFeeAmountCents === null) {
    throw new Error(
      "DIRECT_BOOKING_DESTINATION_FEE_RECOVERY_STRIPE_FEE_INVALID"
    );
  }

  const transferId =
    objectId(chargeAny.transfer) ??
    String(reservation.stripeTransferId ?? "").trim() ||
    null;

  if (!transferId?.startsWith("tr_")) {
    throw new Error(
      "DIRECT_BOOKING_DESTINATION_FEE_RECOVERY_TRANSFER_MISSING"
    );
  }

  const applicationFeeAmountCents =
    normalizeCents(paymentIntent.application_fee_amount) ?? 0;
  const chargeAmountCents = normalizeCents(paymentIntent.amount);

  if (chargeAmountCents === null || chargeAmountCents <= 0) {
    throw new Error(
      "DIRECT_BOOKING_DESTINATION_FEE_RECOVERY_CHARGE_AMOUNT_INVALID"
    );
  }

  const maximumRecoverableFromHostCents = Math.max(
    0,
    chargeAmountCents - applicationFeeAmountCents
  );
  const recoverableFeeAmountCents = Math.min(
    stripeProcessingFeeAmountCents,
    maximumRecoverableFromHostCents
  );

  if (recoverableFeeAmountCents <= 0) {
    throw new Error(
      "DIRECT_BOOKING_DESTINATION_FEE_RECOVERY_NO_HOST_FUNDS_AVAILABLE"
    );
  }

  const reversal = await input.stripeClient.transfers.createReversal(
    transferId,
    {
      amount: recoverableFeeAmountCents,
      refund_application_fee: false,
      metadata: {
        platform: "PinGo",
        product: "Direct Booking Stripe Fee Pass-Through",
        reservationId: reservation.id,
        checkoutSessionId: session.id,
        paymentIntentId,
        chargeId: charge.id,
        balanceTransactionId: balanceTransaction.id,
      },
    },
    {
      idempotencyKey:
        `direct-booking-stripe-fee-recovery:${reservation.id}:` +
        balanceTransaction.id,
    }
  );

  const unrecoveredFeeAmountCents = Math.max(
    0,
    stripeProcessingFeeAmountCents - recoverableFeeAmountCents
  );
  const hostNetAmountCents = Math.max(
    0,
    chargeAmountCents -
      applicationFeeAmountCents -
      recoverableFeeAmountCents
  );
  const reconciledAt = input.now ?? new Date();
  const evidence: DirectBookingDestinationStripeFeeEvidence = {
    stripeChargeId: charge.id,
    stripeTransferId: transferId,
    stripeApplicationFeeId: objectId(chargeAny.application_fee),
    stripeBalanceTransactionId: balanceTransaction.id,
    stripeProcessingFeeAmountCents,
    applicationFeeAmountCents,
    hostNetAmountCents,
    balanceCurrency:
      String(balanceTransaction.currency ?? paymentIntent.currency ?? "")
        .trim()
        .toLowerCase() || "usd",
    transferReversalId: reversal.id,
    transferReversalAmountCents: recoverableFeeAmountCents,
  };

  await input.reservationRepository.update({
    where: {
      id: reservation.id,
    },
    data: {
      stripeChargeId:
        evidence.stripeChargeId ?? reservation.stripeChargeId ?? undefined,
      stripeTransferId:
        evidence.stripeTransferId ?? reservation.stripeTransferId ?? undefined,
      stripeApplicationFeeId:
        evidence.stripeApplicationFeeId ??
        reservation.stripeApplicationFeeId ??
        undefined,
      hostPayoutAmount: centsToMoney(hostNetAmountCents),
      hostPayoutLastSyncedAt: reconciledAt,
      externalRaw: {
        ...previousExternalRaw,
        stripeFinancialEvidence: {
          chargeMode: "DESTINATION_CHARGE",
          stripeAccount: null,
          stripeChargeId: evidence.stripeChargeId,
          stripeTransferId: evidence.stripeTransferId,
          stripeApplicationFeeId: evidence.stripeApplicationFeeId,
          stripeBalanceTransactionId: evidence.stripeBalanceTransactionId,
          stripeProcessingFeeAmountCents:
            evidence.stripeProcessingFeeAmountCents,
          stripeProcessingFeeAmount: centsToMoney(
            evidence.stripeProcessingFeeAmountCents
          ),
          applicationFeeAmountCents: evidence.applicationFeeAmountCents,
          applicationFeeAmount: centsToMoney(
            evidence.applicationFeeAmountCents
          ),
          hostNetAmountCents: evidence.hostNetAmountCents,
          hostNetAmount: centsToMoney(evidence.hostNetAmountCents),
          balanceCurrency: evidence.balanceCurrency,
          unrecoveredStripeProcessingFeeAmountCents:
            unrecoveredFeeAmountCents,
          unrecoveredStripeProcessingFeeAmount: centsToMoney(
            unrecoveredFeeAmountCents
          ),
          processingFeeRecovery: {
            status: "RECOVERED",
            transferReversalId: evidence.transferReversalId,
            amountCents: evidence.transferReversalAmountCents,
            amount: centsToMoney(evidence.transferReversalAmountCents),
            recoveredAt: reconciledAt.toISOString(),
          },
          reconciledAt: reconciledAt.toISOString(),
          source: "STRIPE_BALANCE_TRANSACTION_AND_TRANSFER_REVERSAL",
        },
      },
    },
  });

  return {
    handled: true as const,
    idempotentReplay: false as const,
    reservationId: reservation.id,
    paymentIntentId,
    stripeChargeId: evidence.stripeChargeId,
    stripeTransferId: evidence.stripeTransferId,
    stripeBalanceTransactionId: evidence.stripeBalanceTransactionId,
    stripeProcessingFeeAmountCents:
      evidence.stripeProcessingFeeAmountCents,
    recoveredFeeAmountCents: recoverableFeeAmountCents,
    unrecoveredFeeAmountCents,
    hostNetAmountCents,
    transferReversalId: evidence.transferReversalId,
  };
}
