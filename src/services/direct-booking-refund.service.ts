import {
  CancellationActor,
  HostPayoutStatus,
  PaymentState,
  PrismaClient,
  ReservationStatus,
} from "@prisma/client";
import { formatInTimeZone } from "date-fns-tz";
import stripe from "../billing/stripe";
import { reconcileReservation } from "./reservation.reconcile.service";
import { persistChannexAriReservationIntent } from "../pms/outbound/channex-ari-reservation-producer.service";

const prisma = new PrismaClient();

export type DirectBookingRefundMode = "FULL" | "PARTIAL";

export type RefundDirectBookingReservationInput = {
  organizationId: string;
  reservationId: string;
  reason?: string;
  refundMode?: DirectBookingRefundMode;
  refundAmountCents?: number | null;
  refundPercent?: number | null;
  cancellationEvaluation?: unknown;
  requestedByUserId?: string | null;
  requestedByActor?: CancellationActor;
};

export class DirectBookingRefundError extends Error {
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
    this.name = "DirectBookingRefundError";
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
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

function toNumber(value: unknown) {
  if (value === null || value === undefined) return null;

  const numberValue = Number(value);

  return Number.isFinite(numberValue) ? numberValue : null;
}

function toMoneyFromCents(cents: number) {
  return Number((Math.max(0, Math.round(cents)) / 100).toFixed(2));
}

function normalizeJsonObject(value: unknown) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return {};
}

function normalizeJsonArray(value: unknown) {
  return Array.isArray(value) ? value : [];
}

function shouldRefundApplicationFee(platformFeeAmount: unknown) {
  const amount = toNumber(platformFeeAmount);

  return Boolean(amount && amount > 0);
}

function clampRefundPercent(value: unknown, fallback: number) {
  const numberValue = Number(value);

  if (!Number.isFinite(numberValue)) {
    return Number(fallback.toFixed(2));
  }

  return Number(Math.max(0, Math.min(100, numberValue)).toFixed(2));
}

function getRefundPercentFromCents({
  refundAmountCents,
  totalAmountCents,
}: {
  refundAmountCents: number;
  totalAmountCents: number;
}) {
  if (!Number.isFinite(totalAmountCents) || totalAmountCents <= 0) {
    return 0;
  }

  return Number(((refundAmountCents / totalAmountCents) * 100).toFixed(2));
}

function getExistingStripeRefundId(externalRaw: unknown) {
  const raw = normalizeJsonObject(externalRaw);
  const refund = normalizeJsonObject(raw.refund);

  const refundId = String(refund.stripeRefundId ?? "").trim();

  return refundId || null;
}

function resolveRefundAmountCents({
  refundMode,
  refundAmountCents,
  totalAmountCents,
}: {
  refundMode: DirectBookingRefundMode;
  refundAmountCents?: number | null;
  totalAmountCents: number;
}) {
  if (refundMode === "FULL") {
    return totalAmountCents;
  }

  const amount = Math.round(Number(refundAmountCents ?? 0));

  if (!Number.isFinite(amount) || amount <= 0) {
    throw new DirectBookingRefundError({
      code: "INVALID_PARTIAL_REFUND_AMOUNT",
      message: "Partial refund amount must be greater than zero.",
      statusCode: 400,
      details: {
        refundAmountCents,
        totalAmountCents,
      },
    });
  }

  if (amount > totalAmountCents) {
    throw new DirectBookingRefundError({
      code: "PARTIAL_REFUND_EXCEEDS_TOTAL_AMOUNT",
      message: "Partial refund amount cannot exceed the reservation total.",
      statusCode: 400,
      details: {
        refundAmountCents: amount,
        totalAmountCents,
      },
    });
  }

  return amount;
}

export async function refundDirectBookingReservation({
  organizationId,
  reservationId,
  reason,
  refundMode = "FULL",
  refundAmountCents = null,
  refundPercent = null,
  cancellationEvaluation,
  requestedByUserId = null,
  requestedByActor = CancellationActor.HOST,
}: RefundDirectBookingReservationInput) {
  if (refundMode !== "FULL" && refundMode !== "PARTIAL") {
    throw new DirectBookingRefundError({
      code: "UNSUPPORTED_REFUND_MODE",
      message: "Unsupported refund mode.",
      statusCode: 400,
    });
  }

  const reservation = await prisma.reservation.findFirst({
    where: {
      id: reservationId,
      property: {
        organizationId,
      },
    },
    include: {
      property: {
        select: {
          id: true,
          name: true,
          timezone: true,
          organizationId: true,
          distributionEnabled: true,
          distributionStatus: true,
        },
      },
    },
  });

  if (!reservation) {
    throw new DirectBookingRefundError({
      code: "RESERVATION_NOT_FOUND",
      message: "Reservation not found.",
      statusCode: 404,
    });
  }

  if (!isDirectBookingReservation(reservation)) {
    throw new DirectBookingRefundError({
      code: "NOT_DIRECT_BOOKING_RESERVATION",
      message: "Only Pin&Go Direct Booking reservations can be refunded here.",
      statusCode: 400,
    });
  }

  const existingStripeRefundId = getExistingStripeRefundId(
    reservation.externalRaw
  );

  if (
    reservation.paymentState === PaymentState.REFUNDED ||
    existingStripeRefundId
  ) {
    throw new DirectBookingRefundError({
      code: "RESERVATION_ALREADY_REFUNDED",
      message: "This reservation already has a recorded refund.",
      statusCode: 409,
      details: {
        stripeRefundId: existingStripeRefundId,
      },
    });
  }

  if (!reservation.stripePaymentIntentId) {
    throw new DirectBookingRefundError({
      code: "MISSING_STRIPE_PAYMENT_INTENT",
      message: "This reservation does not have a Stripe payment intent.",
      statusCode: 400,
    });
  }

  const totalAmount = toNumber(reservation.totalAmount);

  if (!totalAmount || totalAmount <= 0) {
    throw new DirectBookingRefundError({
      code: "INVALID_REFUND_AMOUNT",
      message: "Reservation total amount is invalid for refund.",
      statusCode: 400,
    });
  }

  const totalAmountCents = Math.round(totalAmount * 100);

  if (!Number.isFinite(totalAmountCents) || totalAmountCents <= 0) {
    throw new DirectBookingRefundError({
      code: "INVALID_REFUND_AMOUNT_CENTS",
      message: "Reservation total amount is invalid for refund.",
      statusCode: 400,
    });
  }

  const resolvedRefundAmountCents = resolveRefundAmountCents({
    refundMode,
    refundAmountCents,
    totalAmountCents,
  });

  const isFullRefund = resolvedRefundAmountCents >= totalAmountCents;
  const effectiveRefundMode: DirectBookingRefundMode = isFullRefund
    ? "FULL"
    : "PARTIAL";

  const resolvedRefundAmount = toMoneyFromCents(resolvedRefundAmountCents);

  const effectiveRefundPercent =
    refundPercent !== null && refundPercent !== undefined
      ? clampRefundPercent(refundPercent, 0)
      : clampRefundPercent(
          getRefundPercentFromCents({
            refundAmountCents: resolvedRefundAmountCents,
            totalAmountCents,
          }),
          0
        );

  const refundReason =
    reason?.trim() ||
    (effectiveRefundMode === "FULL"
      ? "Direct Booking reservation cancelled with full refund"
      : "Direct Booking reservation cancelled with partial refund");

  const previousExternalRaw = normalizeJsonObject(reservation.externalRaw);
  const previousRefunds = normalizeJsonArray(previousExternalRaw.refunds);

  const refundApplicationFee = shouldRefundApplicationFee(
    reservation.platformFeeAmount
  );

  const refundIdempotencyKey = `direct-booking-refund:${reservation.id}:${resolvedRefundAmountCents}`;

  try {
    const refund = await stripe.refunds.create(
      {
        payment_intent: reservation.stripePaymentIntentId,
        amount: resolvedRefundAmountCents,
        reverse_transfer: true,
        refund_application_fee: refundApplicationFee,
        metadata: {
          platform: "PinGo",
          product: "Refunds & Cancellations V1.2",
          reservationId: reservation.id,
          propertyId: reservation.propertyId,
          organizationId,
          requestedByUserId: requestedByUserId ?? "",
          requestedByActor,
          reason: refundReason,
          refundMode: effectiveRefundMode,
          refundAmountCents: String(resolvedRefundAmountCents),
          refundAmount: String(resolvedRefundAmount),
          refundPercent: String(effectiveRefundPercent),
        },
      },
      {
        idempotencyKey: refundIdempotencyKey,
      }
    );

    const refundedAt = new Date();

    const refundRecord = {
      stripeRefundId: refund.id,
      status: refund.status,
      amount: resolvedRefundAmount,
      amountCents: refund.amount,
      currency: refund.currency,
      reason: refundReason,
      refundMode: effectiveRefundMode,
      refundPercent: effectiveRefundPercent,
      isFullRefund,
      reverseTransfer: true,
      refundApplicationFee,
      refundedAt: refundedAt.toISOString(),
      requestedByUserId,
      requestedByActor,
      idempotencyKey: refundIdempotencyKey,
    };

    const updateData: any = {
      status: ReservationStatus.CANCELLED,
      paymentState: isFullRefund
        ? PaymentState.REFUNDED
        : PaymentState.PARTIALLY_REFUNDED,
      hostPayoutStatus: isFullRefund
        ? HostPayoutStatus.REFUNDED
        : HostPayoutStatus.PARTIALLY_REFUNDED,
      hostPayoutFailureReason: null,
      hostPayoutLastSyncedAt: refundedAt,
      cancelledAt: reservation.cancelledAt ?? refundedAt,
      cancelledBy: reservation.cancelledBy ?? requestedByActor,
      cancelledByUserId: reservation.cancelledByUserId ?? requestedByUserId,
      cancellationRequestedAt: reservation.cancellationRequestedAt ?? refundedAt,
      cancellationRequestedBy:
        reservation.cancellationRequestedBy ?? requestedByActor,
      cancellationReason: refundReason,
      cancellationRefundAmount: resolvedRefundAmount,
      cancellationRefundPercent: effectiveRefundPercent,
      externalRaw: {
        ...previousExternalRaw,
        refund: refundRecord,
        refunds: [...previousRefunds, refundRecord],
      },
    };

    if (cancellationEvaluation !== undefined) {
      updateData.cancellationEvaluation = cancellationEvaluation as any;
      updateData.cancellationEvaluatedAt =
        reservation.cancellationEvaluatedAt ?? refundedAt;
    }

    const updatedReservation = await prisma.$transaction(async (tx) => {
      const persistedReservation = await tx.reservation.update({
        where: {
          id: reservation.id,
        },
        data: updateData,
        select: {
          id: true,
          status: true,
          paymentState: true,
          hostPayoutStatus: true,
          totalAmount: true,
          currency: true,
          propertyId: true,
          checkIn: true,
          checkOut: true,
          cancellationRefundAmount: true,
          cancellationRefundPercent: true,
        },
      });

      if (
        reservation.property.distributionEnabled === true &&
        reservation.property.distributionStatus === "ACTIVE"
      ) {
        const propertyTimezone =
          reservation.property.timezone ?? "America/Puerto_Rico";

        await persistChannexAriReservationIntent({
          db: tx,
          organizationId: reservation.property.organizationId,
          propertyId: persistedReservation.propertyId,
          reservationId: persistedReservation.id,
          previous: {
            checkIn: reservation.checkIn,
            checkOut: reservation.checkOut,
            status: reservation.status,
          },
          current: {
            checkIn: persistedReservation.checkIn,
            checkOut: persistedReservation.checkOut,
            status: persistedReservation.status,
          },
          propertyTimezone,
          todayDateKey: formatInTimeZone(
            refundedAt,
            propertyTimezone,
            "yyyy-MM-dd"
          ),
          now: refundedAt,
        });
      }

      return persistedReservation;
    });

    await reconcileReservation(reservation.id);

    return {
      ok: true,
      reservation: {
        id: updatedReservation.id,
        status: updatedReservation.status,
        paymentState: updatedReservation.paymentState,
        hostPayoutStatus: updatedReservation.hostPayoutStatus,
        totalAmount: updatedReservation.totalAmount
          ? Number(updatedReservation.totalAmount)
          : null,
        currency: updatedReservation.currency,
        cancellationRefundAmount: updatedReservation.cancellationRefundAmount
          ? Number(updatedReservation.cancellationRefundAmount)
          : null,
        cancellationRefundPercent:
          updatedReservation.cancellationRefundPercent !== null &&
          updatedReservation.cancellationRefundPercent !== undefined
            ? Number(updatedReservation.cancellationRefundPercent)
            : null,
      },
      refund: {
        id: refund.id,
        status: refund.status,
        amount: refund.amount,
        amountCents: refund.amount,
        amountDecimal: resolvedRefundAmount,
        currency: refund.currency,
        refundMode: effectiveRefundMode,
        refundPercent: effectiveRefundPercent,
        isFullRefund,
      },
      distributionSyncResult: null,
    };
  } catch (error: any) {
    console.error("[DIRECT_BOOKING_REFUND_ERROR]", {
      reservationId,
      paymentIntentId: reservation.stripePaymentIntentId,
      refundMode,
      refundAmountCents: resolvedRefundAmountCents,
      error: error?.message ?? error,
    });

    await prisma.reservation
      .update({
        where: {
          id: reservation.id,
        },
        data: {
          hostPayoutStatus: HostPayoutStatus.FAILED,
          hostPayoutFailureReason:
            error?.message || "Failed to refund direct booking reservation",
          hostPayoutLastSyncedAt: new Date(),
        },
      })
      .catch(() => {});

    throw new DirectBookingRefundError({
      code: "DIRECT_BOOKING_REFUND_FAILED",
      message:
        error?.message || "Failed to refund direct booking reservation.",
      statusCode: error?.statusCode || 500,
      details: {
        reservationId,
        paymentIntentId: reservation.stripePaymentIntentId,
        refundMode,
        refundAmountCents: resolvedRefundAmountCents,
      },
    });
  }
}