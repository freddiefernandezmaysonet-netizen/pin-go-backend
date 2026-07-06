import {
  HostPayoutStatus,
  PaymentState,
  PrismaClient,
  ReservationStatus,
} from "@prisma/client";
import stripe from "../billing/stripe";
import { syncChannexAvailabilityForProperty } from "./channex-availability-sync.service";
import { reconcileReservation } from "./reservation.reconcile.service";

const prisma = new PrismaClient();

export type DirectBookingRefundMode = "FULL";

export type RefundDirectBookingReservationInput = {
  organizationId: string;
  reservationId: string;
  reason?: string;
  refundMode?: DirectBookingRefundMode;
  requestedByUserId?: string | null;
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

function normalizeJsonObject(value: unknown) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return {};
}

function shouldRefundApplicationFee(platformFeeAmount: unknown) {
  const amount = toNumber(platformFeeAmount);

  return Boolean(amount && amount > 0);
}

export async function refundDirectBookingReservation({
  organizationId,
  reservationId,
  reason,
  refundMode = "FULL",
  requestedByUserId = null,
}: RefundDirectBookingReservationInput) {
  if (refundMode !== "FULL") {
    throw new DirectBookingRefundError({
      code: "UNSUPPORTED_REFUND_MODE",
      message: "Refunds & Cancellations V1 only supports full refunds.",
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
          organizationId: true,
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

  if (reservation.paymentState === PaymentState.REFUNDED) {
    throw new DirectBookingRefundError({
      code: "RESERVATION_ALREADY_REFUNDED",
      message: "This reservation is already marked as refunded.",
      statusCode: 409,
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

  const refundReason = reason?.trim() || "Direct Booking reservation cancelled";

  try {
    const refund = await stripe.refunds.create({
      payment_intent: reservation.stripePaymentIntentId,
      reverse_transfer: true,
      refund_application_fee: shouldRefundApplicationFee(
        reservation.platformFeeAmount
      ),
      metadata: {
        platform: "PinGo",
        product: "Refunds & Cancellations V1",
        reservationId: reservation.id,
        propertyId: reservation.propertyId,
        organizationId,
        requestedByUserId: requestedByUserId ?? "",
        reason: refundReason,
      },
    });

    const previousExternalRaw = normalizeJsonObject(reservation.externalRaw);

    const updatedReservation = await prisma.reservation.update({
      where: {
        id: reservation.id,
      },
      data: {
        status: ReservationStatus.CANCELLED,
        paymentState: PaymentState.REFUNDED,
        hostPayoutStatus: HostPayoutStatus.REFUNDED,
        hostPayoutFailureReason: null,
        hostPayoutLastSyncedAt: new Date(),
        externalRaw: {
          ...previousExternalRaw,
          refund: {
            stripeRefundId: refund.id,
            status: refund.status,
            amount: refund.amount,
            currency: refund.currency,
            reason: refundReason,
            reverseTransfer: true,
            refundApplicationFee: shouldRefundApplicationFee(
              reservation.platformFeeAmount
            ),
            refundedAt: new Date().toISOString(),
            requestedByUserId,
          },
        },
      },
      select: {
        id: true,
        status: true,
        paymentState: true,
        hostPayoutStatus: true,
        totalAmount: true,
        currency: true,
        propertyId: true,
      },
    });

    await reconcileReservation(reservation.id);

    let distributionSyncResult: unknown = null;

    try {
      distributionSyncResult = await syncChannexAvailabilityForProperty(
        reservation.propertyId
      );

      await prisma.property.update({
        where: {
          id: reservation.propertyId,
        },
        data: {
          distributionLastSyncedAt: new Date(),
          distributionLastError: null,
        },
      });
    } catch (syncError: any) {
      console.error("[DIRECT_BOOKING_REFUND_CHANNEX_SYNC_ERROR]", {
        reservationId: reservation.id,
        propertyId: reservation.propertyId,
        error: syncError?.message ?? syncError,
      });

      await prisma.property.update({
        where: {
          id: reservation.propertyId,
        },
        data: {
          distributionLastError:
            syncError?.message ||
            "Failed to sync Channex after direct booking refund",
        },
      });
    }

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
      },
      refund: {
        id: refund.id,
        status: refund.status,
        amount: refund.amount,
        currency: refund.currency,
      },
      distributionSyncResult,
    };
  } catch (error: any) {
    console.error("[DIRECT_BOOKING_REFUND_ERROR]", {
      reservationId,
      paymentIntentId: reservation.stripePaymentIntentId,
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
      },
    });
  }
}