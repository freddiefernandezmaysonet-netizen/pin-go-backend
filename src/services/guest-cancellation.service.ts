import {
  CancellationActor,
  PrismaClient,
  ReservationStatus,
} from "@prisma/client";
import { syncChannexAvailabilityForProperty } from "./channex-availability-sync.service";
import {
  CancellationPolicySnapshot,
  buildCancellationPolicySnapshot,
  evaluateCancellationPolicy,
} from "./cancellation-policy.service";
import { reconcileReservation } from "./reservation.reconcile.service";

const prisma = new PrismaClient();

export type GuestCancellationPreviewInput = {
  guestToken: string;
};

export type GuestCancellationConfirmInput = {
  guestToken: string;
  reason?: string | null;
};

export class GuestCancellationError extends Error {
  statusCode: number;
  code: string;
  details?: unknown;

  constructor({
    code,
    message,
    statusCode = 400,
    details,
  }: {
    code: string;
    message: string;
    statusCode?: number;
    details?: unknown;
  }) {
    super(message);
    this.name = "GuestCancellationError";
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

function normalizeGuestToken(value: unknown) {
  return String(value ?? "").trim();
}

function normalizeReason(value: unknown) {
  const text = String(value ?? "").trim();

  if (!text) {
    return "Guest self-cancellation";
  }

  return text.slice(0, 500);
}

function normalizeJsonObject(value: unknown) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return {};
}

function isDirectBookingReservation(reservation: {
  source: string | null;
  externalProvider: string | null;
  stripeCheckoutSessionId: string | null;
}) {
  return (
    reservation.source === "DIRECT_BOOKING" ||
    reservation.externalProvider === "PIN_GO_DIRECT" ||
    Boolean(reservation.stripeCheckoutSessionId)
  );
}

async function getReservationByGuestToken(guestTokenInput: string) {
  const guestToken = normalizeGuestToken(guestTokenInput);

  if (!guestToken) {
    throw new GuestCancellationError({
      code: "MISSING_GUEST_TOKEN",
      message: "Missing guest reservation token.",
      statusCode: 400,
    });
  }

  const now = new Date();

  const reservation = await prisma.reservation.findFirst({
    where: {
      guestToken,
      OR: [
        {
          guestTokenExpiresAt: null,
        },
        {
          guestTokenExpiresAt: {
            gt: now,
          },
        },
      ],
    },
    include: {
      property: {
        select: {
          id: true,
          name: true,
          organizationId: true,
          distributionStatus: true,
        },
      },
    },
  });

  if (!reservation) {
    throw new GuestCancellationError({
      code: "RESERVATION_NOT_FOUND_OR_TOKEN_EXPIRED",
      message: "Reservation not found or guest link has expired.",
      statusCode: 404,
    });
  }

  if (!isDirectBookingReservation(reservation)) {
    throw new GuestCancellationError({
      code: "NOT_DIRECT_BOOKING_RESERVATION",
      message: "Only Pin&Go Direct Booking reservations can be managed here.",
      statusCode: 400,
    });
  }

  return reservation;
}

async function getEffectiveCancellationPolicySnapshot(reservation: {
  propertyId: string;
  cancellationPolicySnapshot: unknown;
}) {
  if (
    reservation.cancellationPolicySnapshot &&
    typeof reservation.cancellationPolicySnapshot === "object" &&
    !Array.isArray(reservation.cancellationPolicySnapshot)
  ) {
    return reservation.cancellationPolicySnapshot as CancellationPolicySnapshot;
  }

  return buildCancellationPolicySnapshot(reservation.propertyId);
}

function getGuestCancellationAction(evaluation: {
  requiresHostApproval: boolean;
  refundAmountCents: number;
}) {
  if (evaluation.requiresHostApproval) {
    return "HOST_APPROVAL_REQUIRED";
  }

  if (evaluation.refundAmountCents > 0) {
    return "CANCELLATION_ALLOWED_REFUND_PENDING";
  }

  return "CANCELLATION_ALLOWED_NO_REFUND";
}

function serializeGuestCancellationPreview({
  reservation,
  snapshot,
  evaluation,
}: {
  reservation: any;
  snapshot: CancellationPolicySnapshot;
  evaluation: ReturnType<typeof evaluateCancellationPolicy>;
}) {
  const action = getGuestCancellationAction(evaluation);

  return {
    reservation: {
      id: reservation.id,
      propertyName: reservation.property?.name ?? reservation.roomName,
      guestName: reservation.guestName,
      guestEmail: reservation.guestEmail,
      checkIn: reservation.checkIn,
      checkOut: reservation.checkOut,
      status: reservation.status,
      paymentState: reservation.paymentState,
      totalAmount: reservation.totalAmount
        ? Number(reservation.totalAmount)
        : null,
      currency: reservation.currency,
      cancelledAt: reservation.cancelledAt,
    },
    policy: {
      name: snapshot.name,
      type: snapshot.type,
      refundBasis: snapshot.refundBasis,
      refundRules: snapshot.refundRules,
      nonRefundableScenarios: snapshot.nonRefundableScenarios,
      guestFacingSummary: snapshot.guestFacingSummary,
      cancellationTermsAcceptance:
        (snapshot as any).cancellationTermsAcceptance ?? null,
    },
    evaluation: {
      requestedAt: evaluation.requestedAt,
      checkIn: evaluation.checkIn,
      freeCancellationDeadline: evaluation.freeCancellationDeadline,
      hoursBeforeCheckIn: evaluation.hoursBeforeCheckIn,
      beforeDeadline: evaluation.beforeDeadline,
      refundPercent: evaluation.refundPercent,
      refundAmount: evaluation.refundAmount,
      refundAmountCents: evaluation.refundAmountCents,
      usesTieredRules: evaluation.usesTieredRules,
      matchedRefundRule: evaluation.matchedRefundRule,
      eligibleForGuestSelfCancellation:
        evaluation.eligibleForGuestSelfCancellation,
      eligibleForAutoRefund: evaluation.eligibleForAutoRefund,
      requiresHostApproval: evaluation.requiresHostApproval,
      reason: evaluation.reason,
      breakdown: evaluation.breakdown,
    },
    action,
    refundExecution:
      evaluation.refundAmountCents > 0
        ? "REFUND_NOT_EXECUTED_IN_V1"
        : "NO_REFUND_DUE",
  };
}

export async function getGuestCancellationPreview({
  guestToken,
}: GuestCancellationPreviewInput) {
  const reservation = await getReservationByGuestToken(guestToken);
  const snapshot = await getEffectiveCancellationPolicySnapshot(reservation);

  const evaluation = evaluateCancellationPolicy({
    snapshot,
    checkIn: reservation.checkIn,
    totalAmount: reservation.totalAmount,
    pricingBreakdown: reservation.pricingBreakdown,
    requestedAt: new Date(),
    actor: CancellationActor.GUEST,
  });

  return serializeGuestCancellationPreview({
    reservation,
    snapshot,
    evaluation,
  });
}

export async function cancelReservationFromGuestPortal({
  guestToken,
  reason,
}: GuestCancellationConfirmInput) {
  const reservation = await getReservationByGuestToken(guestToken);

  if (reservation.status === ReservationStatus.CANCELLED) {
    const snapshot = await getEffectiveCancellationPolicySnapshot(reservation);

    const evaluation = evaluateCancellationPolicy({
      snapshot,
      checkIn: reservation.checkIn,
      totalAmount: reservation.totalAmount,
      pricingBreakdown: reservation.pricingBreakdown,
      requestedAt: new Date(),
      actor: CancellationActor.GUEST,
    });

    return {
      ok: true,
      alreadyCancelled: true,
      ...serializeGuestCancellationPreview({
        reservation,
        snapshot,
        evaluation,
      }),
    };
  }

  const snapshot = await getEffectiveCancellationPolicySnapshot(reservation);
  const requestedAt = new Date();

  const evaluation = evaluateCancellationPolicy({
    snapshot,
    checkIn: reservation.checkIn,
    totalAmount: reservation.totalAmount,
    pricingBreakdown: reservation.pricingBreakdown,
    requestedAt,
    actor: CancellationActor.GUEST,
  });

  const cancellationReason = normalizeReason(reason);
  const previousExternalRaw = normalizeJsonObject(reservation.externalRaw);

  if (evaluation.requiresHostApproval) {
    await prisma.reservation.update({
      where: {
        id: reservation.id,
      },
      data: {
        cancellationRequestedAt: requestedAt,
        cancellationRequestedBy: CancellationActor.GUEST,
        cancellationEvaluatedAt: requestedAt,
        cancellationEvaluation: evaluation as any,
        cancellationReason,
        cancellationRefundAmount: evaluation.refundAmount,
        cancellationRefundPercent: evaluation.refundPercent,
        externalRaw: {
          ...previousExternalRaw,
          guestCancellation: {
            requestedAt: requestedAt.toISOString(),
            requestedBy: CancellationActor.GUEST,
            reason: cancellationReason,
            action: "HOST_APPROVAL_REQUIRED",
            refundExecution: "NOT_EXECUTED_HOST_APPROVAL_REQUIRED",
            evaluation,
          },
        },
      },
    });

    throw new GuestCancellationError({
      code: "CANCELLATION_REQUIRES_HOST_APPROVAL",
      message:
        "This cancellation requires host approval and cannot be completed automatically.",
      statusCode: 409,
      details: serializeGuestCancellationPreview({
        reservation,
        snapshot,
        evaluation,
      }),
    });
  }

  const cancelledAt = new Date();

  const updatedReservation = await prisma.reservation.update({
    where: {
      id: reservation.id,
    },
    data: {
      status: ReservationStatus.CANCELLED,
      cancelledAt,
      cancelledBy: CancellationActor.GUEST,
      cancelledByUserId: null,
      cancellationRequestedAt: requestedAt,
      cancellationRequestedBy: CancellationActor.GUEST,
      cancellationEvaluatedAt: requestedAt,
      cancellationEvaluation: evaluation as any,
      cancellationReason,
      cancellationRefundAmount: evaluation.refundAmount,
      cancellationRefundPercent: evaluation.refundPercent,
      externalRaw: {
        ...previousExternalRaw,
        guestCancellation: {
          requestedAt: requestedAt.toISOString(),
          cancelledAt: cancelledAt.toISOString(),
          requestedBy: CancellationActor.GUEST,
          cancelledBy: CancellationActor.GUEST,
          reason: cancellationReason,
          action: getGuestCancellationAction(evaluation),
          refundExecution:
            evaluation.refundAmountCents > 0
              ? "REFUND_NOT_EXECUTED_IN_V1"
              : "NO_REFUND_DUE",
          evaluation,
        },
      },
    },
    include: {
      property: {
        select: {
          id: true,
          name: true,
          organizationId: true,
          distributionStatus: true,
        },
      },
    },
  });

  await reconcileReservation(updatedReservation.id);

  let distributionSyncResult: unknown = null;

  try {
    distributionSyncResult = await syncChannexAvailabilityForProperty(
      updatedReservation.propertyId
    );

    await prisma.property.update({
      where: {
        id: updatedReservation.propertyId,
      },
      data: {
        distributionLastSyncedAt: new Date(),
        distributionLastError: null,
      },
    });
  } catch (syncError: any) {
    console.error("[GUEST_CANCELLATION_CHANNEX_SYNC_ERROR]", {
      reservationId: updatedReservation.id,
      propertyId: updatedReservation.propertyId,
      error: syncError?.message ?? syncError,
    });

    await prisma.property.update({
      where: {
        id: updatedReservation.propertyId,
      },
      data: {
        distributionLastError:
          syncError?.message ||
          "Failed to sync Channex after guest cancellation",
      },
    });
  }

  return {
    ok: true,
    alreadyCancelled: false,
    ...serializeGuestCancellationPreview({
      reservation: updatedReservation,
      snapshot,
      evaluation,
    }),
    distributionSyncResult,
  };
}