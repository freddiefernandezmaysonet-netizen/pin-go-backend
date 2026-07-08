import {
  CancellationActor,
  PrismaClient,
  ReservationStatus,
} from "@prisma/client";
import { syncChannexAvailabilityForProperty } from "./channex-availability-sync.service";
import {
  buildCancellationPolicySnapshot,
  evaluateCancellationPolicy,
} from "./cancellation-policy.service";
import type { CancellationPolicySnapshot } from "./cancellation-policy.service";
import { refundDirectBookingReservation } from "./direct-booking-refund.service";
import { sendDirectBookingGuestCancellationEmail } from "../lib/mailer";
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

function toNumber(value: unknown) {
  if (value === null || value === undefined) return null;

  const numberValue = Number(value);

  return Number.isFinite(numberValue) ? numberValue : null;
}

function getAppUrl() {
  return String(process.env.APP_URL ?? "http://localhost:3000")
    .trim()
    .replace(/\/+$/, "");
}

function buildManageReservationUrl(guestToken: unknown) {
  const token = normalizeGuestToken(guestToken);

  if (!token) return null;

  return `${getAppUrl()}/booking/manage/${encodeURIComponent(token)}`;
}

function getRefundAmountForEmail({
  refund,
  evaluation,
  refundExecution,
}: {
  refund?: unknown;
  evaluation: ReturnType<typeof evaluateCancellationPolicy>;
  refundExecution: string;
}) {
  const refundRecord = normalizeJsonObject(refund);

  const amountDecimal = toNumber(refundRecord.amountDecimal);

  if (amountDecimal !== null) {
    return amountDecimal;
  }

  const amountCents = toNumber(refundRecord.amountCents);

  if (amountCents !== null) {
    return Number((Math.max(0, Math.round(amountCents)) / 100).toFixed(2));
  }

  if (refundExecution === "NO_REFUND_DUE") {
    return 0;
  }

  if (refundExecution === "REFUND_PENDING_PROPERTY_WORKFLOW") {
    return evaluation.refundAmount;
  }

  return evaluation.refundAmount;
}

function getNonRefundableAmountForEmail({
  reservation,
  refundAmount,
}: {
  reservation: any;
  refundAmount: number | null;
}) {
  const totalAmount = toNumber(reservation.totalAmount);

  if (totalAmount === null || refundAmount === null) {
    return null;
  }

  return Number(Math.max(0, totalAmount - refundAmount).toFixed(2));
}

function getRefundStatusForEmail(refund?: unknown) {
  const refundRecord = normalizeJsonObject(refund);
  const status = String(refundRecord.status ?? "").trim();

  return status || null;
}

function getStripeRefundIdForEmail(refund?: unknown) {
  const refundRecord = normalizeJsonObject(refund);
  const id = String(refundRecord.id ?? refundRecord.stripeRefundId ?? "").trim();

  return id || null;
}

function getRefundModeForEmail(refund?: unknown) {
  const refundRecord = normalizeJsonObject(refund);
  const refundMode = String(refundRecord.refundMode ?? "").trim();

  return refundMode || null;
}

async function sendGuestCancellationEmailSafe({
  reservation,
  snapshot,
  evaluation,
  refundExecution,
  refund,
}: {
  reservation: any;
  snapshot: CancellationPolicySnapshot;
  evaluation: ReturnType<typeof evaluateCancellationPolicy>;
  refundExecution: string;
  refund?: unknown;
}) {
  if (!reservation.guestEmail) {
    return null;
  }

  const refundAmount = getRefundAmountForEmail({
    refund,
    evaluation,
    refundExecution,
  });

  try {
    return await sendDirectBookingGuestCancellationEmail({
      to: reservation.guestEmail,
      guestName: reservation.guestName,
      propertyName: reservation.property?.name ?? reservation.roomName ?? "Your stay",
      checkIn: reservation.checkIn,
      checkOut: reservation.checkOut,
      totalAmount: reservation.totalAmount ? Number(reservation.totalAmount) : null,
      currency: reservation.currency,
      cancelledAt: reservation.cancelledAt ?? new Date(),
      refundExecution,
      refundAmount,
      refundStatus: getRefundStatusForEmail(refund),
      stripeRefundId: getStripeRefundIdForEmail(refund),
      refundMode: getRefundModeForEmail(refund),
      refundBasis: snapshot.refundBasis,
      nonRefundableAmount: getNonRefundableAmountForEmail({
        reservation,
        refundAmount,
      }),
      manageReservationUrl: buildManageReservationUrl(reservation.guestToken),
    });
  } catch (emailError: any) {
    console.error("[GUEST_CANCELLATION_EMAIL_ERROR]", {
      reservationId: reservation.id,
      guestEmail: reservation.guestEmail,
      refundExecution,
      error: emailError?.message ?? emailError,
    });

    return null;
  }
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

function getRecordedRefund(externalRaw: unknown) {
  const raw = normalizeJsonObject(externalRaw);
  const refund = normalizeJsonObject(raw.refund);
  const stripeRefundId = String(refund.stripeRefundId ?? "").trim();

  if (!stripeRefundId) {
    return null;
  }

  return {
    stripeRefundId,
    status: String(refund.status ?? "").trim() || null,
    amount:
      typeof refund.amount === "number"
        ? refund.amount
        : Number(refund.amount ?? 0),
    amountCents:
      typeof refund.amountCents === "number"
        ? refund.amountCents
        : Number(refund.amountCents ?? 0),
    currency: String(refund.currency ?? "").trim() || null,
    reason: String(refund.reason ?? "").trim() || null,
    refundMode: String(refund.refundMode ?? "").trim() || null,
    refundPercent:
      typeof refund.refundPercent === "number"
        ? refund.refundPercent
        : Number(refund.refundPercent ?? 0),
    isFullRefund: Boolean(refund.isFullRefund),
    refundedAt: String(refund.refundedAt ?? "").trim() || null,
  };
}

function getRefundExecution({
  reservation,
  evaluation,
}: {
  reservation: any;
  evaluation: ReturnType<typeof evaluateCancellationPolicy>;
}) {
  const recordedRefund = getRecordedRefund(reservation.externalRaw);

  if (recordedRefund) {
    return recordedRefund.isFullRefund
      ? "FULL_REFUND_EXECUTED"
      : "PARTIAL_REFUND_EXECUTED";
  }

  if (evaluation.requiresHostApproval) {
    return "NOT_EXECUTED_HOST_APPROVAL_REQUIRED";
  }

  if (evaluation.refundAmountCents > 0) {
    return evaluation.eligibleForAutoRefund
      ? "AUTO_REFUND_READY"
      : "REFUND_PENDING_PROPERTY_WORKFLOW";
  }

  return "NO_REFUND_DUE";
}

function serializeGuestCancellationPreview({
  reservation,
  snapshot,
  evaluation,
  refundExecution,
  refund,
}: {
  reservation: any;
  snapshot: CancellationPolicySnapshot;
  evaluation: ReturnType<typeof evaluateCancellationPolicy>;
  refundExecution?: string | null;
  refund?: unknown;
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
      refundExecution ??
      getRefundExecution({
        reservation,
        evaluation,
      }),
    refund: refund ?? getRecordedRefund(reservation.externalRaw),
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
        refundExecution: "NOT_EXECUTED_HOST_APPROVAL_REQUIRED",
      }),
    });
  }

  if (
    evaluation.eligibleForAutoRefund &&
    evaluation.refundAmountCents > 0
  ) {
    const refundMode =
      evaluation.refundAmountCents >= evaluation.breakdown.totalAmountCents
        ? "FULL"
        : "PARTIAL";

    try {
      const refundResult = await refundDirectBookingReservation({
        organizationId: reservation.property.organizationId,
        reservationId: reservation.id,
        reason: cancellationReason,
        refundMode,
        refundAmountCents: evaluation.refundAmountCents,
        refundPercent: evaluation.refundPercent,
        cancellationEvaluation: evaluation,
        requestedByUserId: null,
        requestedByActor: CancellationActor.GUEST,
      });

      const updatedReservation = await getReservationByGuestToken(guestToken);
      const refundExecution =
        refundMode === "FULL"
          ? "FULL_REFUND_EXECUTED"
          : "PARTIAL_REFUND_EXECUTED";

      await sendGuestCancellationEmailSafe({
        reservation: updatedReservation,
        snapshot,
        evaluation,
        refundExecution,
        refund: refundResult.refund,
      });

      return {
        ok: true,
        alreadyCancelled: false,
        ...serializeGuestCancellationPreview({
          reservation: updatedReservation,
          snapshot,
          evaluation,
          refundExecution,
          refund: refundResult.refund,
        }),
        refundResult,
      };
    } catch (error: any) {
      console.error("[GUEST_CANCELLATION_AUTO_REFUND_ERROR]", {
        reservationId: reservation.id,
        propertyId: reservation.propertyId,
        refundAmountCents: evaluation.refundAmountCents,
        error: error?.message ?? error,
      });

      await prisma.reservation
        .update({
          where: {
            id: reservation.id,
          },
          data: {
            cancellationRequestedAt: requestedAt,
            cancellationRequestedBy: CancellationActor.GUEST,
            cancellationEvaluatedAt: requestedAt,
            cancellationEvaluation: evaluation as any,
            cancellationReason,
            externalRaw: {
              ...previousExternalRaw,
              guestCancellation: {
                requestedAt: requestedAt.toISOString(),
                requestedBy: CancellationActor.GUEST,
                reason: cancellationReason,
                action: getGuestCancellationAction(evaluation),
                refundExecution: "AUTO_REFUND_FAILED",
                refundError: {
                  code: error?.code ?? "AUTO_REFUND_FAILED",
                  message: error?.message ?? "Automatic refund failed.",
                  statusCode: error?.statusCode ?? 500,
                  details: error?.details ?? null,
                },
                evaluation,
              },
            },
          },
        })
        .catch(() => {});

      throw new GuestCancellationError({
        code: "GUEST_AUTO_REFUND_FAILED",
        message:
          error?.message ||
          "Pin&Go could not process the automatic refund for this cancellation.",
        statusCode: error?.statusCode || 500,
        details: serializeGuestCancellationPreview({
          reservation,
          snapshot,
          evaluation,
          refundExecution: "AUTO_REFUND_FAILED",
        }),
      });
    }
  }

  const cancelledAt = new Date();

  const refundExecution =
    evaluation.refundAmountCents > 0
      ? "REFUND_PENDING_PROPERTY_WORKFLOW"
      : "NO_REFUND_DUE";

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
          refundExecution,
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

  await sendGuestCancellationEmailSafe({
    reservation: updatedReservation,
    snapshot,
    evaluation,
    refundExecution,
  });

  return {
    ok: true,
    alreadyCancelled: false,
    ...serializeGuestCancellationPreview({
      reservation: updatedReservation,
      snapshot,
      evaluation,
      refundExecution,
    }),
    distributionSyncResult,
  };
}
