import { createHash } from "node:crypto";

import {
  PaymentState,
  Prisma,
  PrismaClient,
  ReservationStatus,
} from "@prisma/client";

import type {
  ClaimedFinancialIntent,
  FinancialOwnerCompletion,
} from "./guest-journey-financial-owner-runtime.service";

const reservationSelect = {
  id: true,
  propertyId: true,
  status: true,
  source: true,
  externalProvider: true,
  paymentState: true,
  totalAmount: true,
  amountCollected: true,
  amountRefunded: true,
  currency: true,
  stripeCheckoutSessionId: true,
  stripePaymentIntentId: true,
  stripeChargeId: true,
  stripeTransferId: true,
  stripeApplicationFeeId: true,
  stripeConnectedAccountId: true,
  hostPayoutAmount: true,
  hostPayoutStatus: true,
  hostPayoutFailureReason: true,
  hostPayoutLastSyncedAt: true,
  property: { select: { organizationId: true } },
} satisfies Prisma.ReservationSelect;

type ReservationFinancialSnapshot = Prisma.ReservationGetPayload<{
  select: typeof reservationSelect;
}>;

export type FinancialEvaluationAdapterResult = {
  providerCalls: 0;
  completion: FinancialOwnerCompletion;
};

function decimalText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "object" && "toString" in value) {
    return String((value as { toString(): string }).toString());
  }
  return String(value);
}

function isPinGoDirectBooking(snapshot: ReservationFinancialSnapshot): boolean {
  const source = String(snapshot.source ?? "").toUpperCase();
  const provider = String(snapshot.externalProvider ?? "").toUpperCase();
  return (
    source.includes("DIRECT") ||
    provider.includes("PIN_GO_DIRECT") ||
    provider.includes("DIRECT_BOOKING")
  );
}

function evidenceFingerprint(snapshot: ReservationFinancialSnapshot): string {
  return createHash("sha256")
    .update(JSON.stringify({
      reservationId: snapshot.id,
      status: snapshot.status,
      source: snapshot.source,
      externalProvider: snapshot.externalProvider,
      paymentState: snapshot.paymentState,
      totalAmount: decimalText(snapshot.totalAmount),
      amountCollected: decimalText(snapshot.amountCollected),
      amountRefunded: decimalText(snapshot.amountRefunded),
      currency: snapshot.currency,
      stripeCheckoutSessionPresent: Boolean(snapshot.stripeCheckoutSessionId),
      stripePaymentIntentPresent: Boolean(snapshot.stripePaymentIntentId),
      stripeChargePresent: Boolean(snapshot.stripeChargeId),
      stripeTransferPresent: Boolean(snapshot.stripeTransferId),
      stripeApplicationFeePresent: Boolean(snapshot.stripeApplicationFeeId),
      stripeConnectedAccountPresent: Boolean(snapshot.stripeConnectedAccountId),
      hostPayoutAmount: decimalText(snapshot.hostPayoutAmount),
      hostPayoutStatus: snapshot.hostPayoutStatus,
      hostPayoutFailurePresent: Boolean(snapshot.hostPayoutFailureReason),
      hostPayoutLastSyncedAt: snapshot.hostPayoutLastSyncedAt?.toISOString() ?? null,
    }))
    .digest("hex");
}

function assertClaimContract(claim: ClaimedFinancialIntent): void {
  if (
    claim.targetEngine !== "FINANCIAL" ||
    claim.intentType !== "REQUEST_PAYMENT_EVALUATION" ||
    claim.expectedOutcomeCode !== "PAYMENT_STATE_RESOLVED"
  ) {
    throw new Error("GUEST_JOURNEY_FINANCIAL_ADAPTER_CONTRACT_MISMATCH");
  }
}

function assertScope(
  claim: ClaimedFinancialIntent,
  snapshot: ReservationFinancialSnapshot
): void {
  if (
    snapshot.propertyId !== claim.propertyId ||
    snapshot.property.organizationId !== claim.organizationId
  ) {
    throw new Error("GUEST_JOURNEY_FINANCIAL_ADAPTER_SCOPE_MISMATCH");
  }
}

export async function executeGuestJourneyFinancialEvaluationAdapter(
  prisma: PrismaClient,
  claim: ClaimedFinancialIntent
): Promise<FinancialEvaluationAdapterResult> {
  assertClaimContract(claim);

  const reservation = await prisma.reservation.findUnique({
    where: { id: claim.reservationId },
    select: reservationSelect,
  });
  if (!reservation) {
    throw new Error("GUEST_JOURNEY_FINANCIAL_RESERVATION_NOT_FOUND");
  }
  assertScope(claim, reservation);

  const fingerprint = evidenceFingerprint(reservation);
  const hostPayoutStatus = String(reservation.hostPayoutStatus ?? "");

  if (reservation.status !== ReservationStatus.ACTIVE) {
    return {
      providerCalls: 0,
      completion: {
        kind: "SUCCEEDED",
        action: "PAYMENT_NOT_REQUIRED_FOR_TERMINAL_RESERVATION",
        paymentState: reservation.paymentState,
        hostPayoutStatus,
        outcomeEvidenceFingerprint: fingerprint,
      },
    };
  }

  if (reservation.paymentState === PaymentState.PAID) {
    if (
      isPinGoDirectBooking(reservation) &&
      (
        !reservation.stripeCheckoutSessionId ||
        !reservation.stripePaymentIntentId
      )
    ) {
      return {
        providerCalls: 0,
        completion: {
          kind: "EXHAUSTED",
          paymentState: reservation.paymentState,
          hostPayoutStatus,
          outcomeEvidenceFingerprint: fingerprint,
          errorCode: "FINANCIAL_DIRECT_BOOKING_STRIPE_EVIDENCE_INCOMPLETE",
          errorDetail:
            "The direct booking is marked PAID but the persisted Stripe checkout session or payment intent is missing. E9 does not call Stripe or mutate payment records.",
        },
      };
    }

    return {
      providerCalls: 0,
      completion: {
        kind: "SUCCEEDED",
        action: "PAYMENT_ALREADY_SATISFIED",
        paymentState: reservation.paymentState,
        hostPayoutStatus,
        outcomeEvidenceFingerprint: fingerprint,
      },
    };
  }

  return {
    providerCalls: 0,
    completion: {
      kind: "WAITING_FOR_EVIDENCE",
      paymentState: reservation.paymentState,
      hostPayoutStatus,
      outcomeEvidenceFingerprint: fingerprint,
      errorCode: "PAYMENT_EVIDENCE_NOT_YET_SATISFIED",
      errorDetail:
        "The reservation has not persisted PAID payment evidence. E9 waits for canonical payment evidence instead of creating or collecting payment.",
    },
  };
}
