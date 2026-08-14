import {
  CancellationActor,
  PrismaClient,
  ReservationStatus,
} from "@prisma/client";
import { formatInTimeZone } from "date-fns-tz";
import { resolveOperationalIssuesForReservation } from "../apms/operational-intelligence.service";
import { persistChannexAriReservationIntent } from "../pms/outbound/channex-ari-reservation-producer.service";
import { auditReservationCompleteFlowSafe } from "./reservation-complete-flow-audit.service";
import { sendLoggedEmail } from "./email-delivery.service";
import { resolveOrganizationGuestReplyTo } from "./organization-guest-email.service";
import { reconcileReservation } from "./reservation.reconcile.service";
import { sendManualReservationGuestCancellationEmail } from "../lib/mailer";
import { notifyCleanerOfManualReservationCancellation } from "./manual-reservation-cleaner-cancellation-notification.service";

const prisma = new PrismaClient();

export type CancelManualReservationByHostInput = {
  organizationId: string;
  reservationId: string;
  reason: string;
  requestedByUserId: string;
};

export class ManualReservationCancellationError extends Error {
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
    this.name = "ManualReservationCancellationError";
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

function normalizeRequiredText(
  value: unknown,
  field: string,
  maxLength = 1000
) {
  const normalized = String(value ?? "").trim();

  if (!normalized) {
    throw new ManualReservationCancellationError({
      code: `MISSING_${field.toUpperCase()}`,
      message: `${field} is required.`,
      statusCode: 400,
    });
  }

  if (normalized.length > maxLength) {
    throw new ManualReservationCancellationError({
      code: `${field.toUpperCase()}_TOO_LONG`,
      message: `${field} must be ${maxLength} characters or fewer.`,
      statusCode: 400,
    });
  }

  return normalized;
}

function isHostCreatedManualReservation(reservation: {
  source: string | null;
  externalProvider: string | null;
}) {
  return (
    String(reservation.source ?? "").trim().toUpperCase() === "MANUAL" &&
    String(reservation.externalProvider ?? "").trim().toUpperCase() ===
      "PIN_GO_MANUAL"
  );
}

async function finalizeManualCancellationOperationsSafe(input: {
  reservationId: string;
  cancelledAt: Date;
}) {
  const errors: Array<{
    operation: string;
    message: string;
  }> = [];

  try {
    await reconcileReservation(input.reservationId);
  } catch (error: any) {
    errors.push({
      operation: "RESERVATION_RECONCILIATION",
      message: String(error?.message ?? error),
    });

    console.error("[HOST_MANUAL_CANCELLATION_RECONCILE_ERROR]", {
      reservationId: input.reservationId,
      error: error?.message ?? error,
    });
  }

  try {
    await prisma.cleaningConfirmation.updateMany({
      where: {
        reservationId: input.reservationId,
        status: {
          in: ["PENDING", "CONFIRMED"],
        },
      },
      data: {
        status: "CANCELLED",
      },
    });
  } catch (error: any) {
    errors.push({
      operation: "CLEANING_CONFIRMATION_CLOSE",
      message: String(error?.message ?? error),
    });

    console.error("[HOST_MANUAL_CANCELLATION_CLEANING_CLOSE_ERROR]", {
      reservationId: input.reservationId,
      error: error?.message ?? error,
    });
  }

  try {
    const cleanerNotification =
      await notifyCleanerOfManualReservationCancellation({
        reservationId: input.reservationId,
        prisma,
      });

    if (
      !cleanerNotification.ok &&
      !cleanerNotification.skipped
    ) {
      throw new Error(
        cleanerNotification.error ??
          "Cleaner cancellation notification failed."
      );
    }
  } catch (error: any) {
    errors.push({
      operation: "CLEANER_CANCELLATION_NOTIFICATION",
      message: String(error?.message ?? error),
    });

    console.error(
      "[HOST_MANUAL_CANCELLATION_CLEANER_NOTIFICATION_ERROR]",
      {
        reservationId: input.reservationId,
        error: error?.message ?? error,
      }
    );
  }

  try {
    const reservation = await prisma.reservation.findUnique({
      where: {
        id: input.reservationId,
      },
      select: {
        id: true,
        reservationNumber: true,
        guestName: true,
        guestEmail: true,
        preferredLanguage: true,
        checkIn: true,
        checkOut: true,
        cancelledAt: true,
        cancellationReason: true,
        propertyId: true,
        property: {
          select: {
            name: true,
            timezone: true,
            organizationId: true,
          },
        },
      },
    });

    if (reservation?.guestEmail) {
      const replyTo = await resolveOrganizationGuestReplyTo(
        prisma,
        reservation.property.organizationId
      );
      const reservationNumber =
        reservation.reservationNumber ?? reservation.id;
      const preferredLanguage = reservation.preferredLanguage;
      const isSpanish =
        String(preferredLanguage ?? "")
          .trim()
          .toLowerCase()
          .startsWith("es");
      const emailInput = {
        to: reservation.guestEmail,
        replyTo: replyTo.email,
        reservationNumber,
        guestName: reservation.guestName,
        propertyName: reservation.property.name,
        checkIn: reservation.checkIn,
        checkOut: reservation.checkOut,
        propertyTimeZone: reservation.property.timezone,
        cancelledAt:
          reservation.cancelledAt ?? input.cancelledAt,
        reason:
          reservation.cancellationReason ??
          "Cancelled by host",
        preferredLanguage,
      };

      const emailResult = await sendLoggedEmail({
        prisma,
        type: "MANUAL_RESERVATION_GUEST_CANCELLATION",
        to: reservation.guestEmail,
        subject: isSpanish
          ? `Reservación #${reservationNumber} cancelada - ${reservation.property.name}`
          : `Reservation #${reservationNumber} cancelled - ${reservation.property.name}`,
        reservationId: reservation.id,
        propertyId: reservation.propertyId,
        organizationId: reservation.property.organizationId,
        retryPayload: {
          reservationNumber,
          guestName: reservation.guestName,
          propertyName: reservation.property.name,
          checkIn: reservation.checkIn.toISOString(),
          checkOut: reservation.checkOut.toISOString(),
          propertyTimeZone: reservation.property.timezone,
          cancelledAt: (
            reservation.cancelledAt ?? input.cancelledAt
          ).toISOString(),
          reason:
            reservation.cancellationReason ??
            "Cancelled by host",
          preferredLanguage,
        },
        send: () =>
          sendManualReservationGuestCancellationEmail(
            emailInput
          ),
      });

      if (!emailResult.ok) {
        throw new Error(
          emailResult.error ??
            "Manual reservation cancellation email was not delivered."
        );
      }
    }
  } catch (error: any) {
    errors.push({
      operation: "GUEST_CANCELLATION_EMAIL",
      message: String(error?.message ?? error),
    });

    console.error("[HOST_MANUAL_CANCELLATION_GUEST_EMAIL_ERROR]", {
      reservationId: input.reservationId,
      error: error?.message ?? error,
    });
  }

  try {
    await resolveOperationalIssuesForReservation(prisma, {
      reservationId: input.reservationId,
      resolutionCode: "RESERVATION_CANCELLED",
      resolutionSummary:
        "The host cancelled this manually created reservation, so its remaining operational workflows are no longer required.",
      resolutionType: "SUPERSEDED",
      resolvedBy: "HOST",
      sourceType: "ENGINE_EVENT",
      decisionId: `host-manual-cancellation:${input.reservationId}`,
      occurredAt: input.cancelledAt,
    });
  } catch (error: any) {
    errors.push({
      operation: "OPERATIONAL_ISSUE_RESOLUTION",
      message: String(error?.message ?? error),
    });

    console.error("[HOST_MANUAL_CANCELLATION_OPERATIONAL_RESOLUTION_ERROR]", {
      reservationId: input.reservationId,
      error: error?.message ?? error,
    });
  }

  try {
    await auditReservationCompleteFlowSafe(input.reservationId, prisma);
  } catch (error: any) {
    errors.push({
      operation: "TERMINAL_COMPLETE_FLOW_AUDIT",
      message: String(error?.message ?? error),
    });

    console.error("[HOST_MANUAL_CANCELLATION_TERMINAL_AUDIT_ERROR]", {
      reservationId: input.reservationId,
      error: error?.message ?? error,
    });
  }

  return {
    ok: errors.length === 0,
    errors,
  };
}

export async function cancelManualReservationByHost({
  organizationId,
  reservationId,
  reason,
  requestedByUserId,
}: CancelManualReservationByHostInput) {
  const cleanOrganizationId = normalizeRequiredText(
    organizationId,
    "organizationId",
    191
  );
  const cleanReservationId = normalizeRequiredText(
    reservationId,
    "reservationId",
    191
  );
  const cleanReason = normalizeRequiredText(reason, "reason");
  const cleanRequestedByUserId = normalizeRequiredText(
    requestedByUserId,
    "requestedByUserId",
    191
  );

  const requestedAt = new Date();

  const cancellationResult = await prisma.$transaction(async (tx) => {
    const reservation = await tx.reservation.findFirst({
      where: {
        id: cleanReservationId,
        property: {
          organizationId: cleanOrganizationId,
        },
      },
      include: {
        property: {
          select: {
            id: true,
            timezone: true,
            organizationId: true,
            distributionEnabled: true,
            distributionStatus: true,
          },
        },
      },
    });

    if (!reservation) {
      throw new ManualReservationCancellationError({
        code: "RESERVATION_NOT_FOUND",
        message: "Reservation not found.",
        statusCode: 404,
      });
    }

    if (!isHostCreatedManualReservation(reservation)) {
      throw new ManualReservationCancellationError({
        code: "NOT_HOST_CREATED_MANUAL_RESERVATION",
        message:
          "Only reservations created manually by the host can be cancelled with this action.",
        statusCode: 409,
      });
    }

    if (reservation.status === ReservationStatus.CANCELLED) {
      return {
        reservation,
        didCancel: false,
      };
    }

    const cancellationUpdate = await tx.reservation.updateMany({
      where: {
        id: reservation.id,
        status: ReservationStatus.ACTIVE,
      },
      data: {
        status: ReservationStatus.CANCELLED,
        cancelledAt: requestedAt,
        cancelledBy: CancellationActor.HOST,
        cancelledByUserId: cleanRequestedByUserId,
        cancellationRequestedAt: requestedAt,
        cancellationRequestedBy: CancellationActor.HOST,
        cancellationReason: cleanReason,
      },
    });

    const persistedReservation = await tx.reservation.findUnique({
      where: {
        id: reservation.id,
      },
      include: {
        property: {
          select: {
            id: true,
            timezone: true,
            organizationId: true,
            distributionEnabled: true,
            distributionStatus: true,
          },
        },
      },
    });

    if (!persistedReservation) {
      throw new ManualReservationCancellationError({
        code: "RESERVATION_NOT_FOUND",
        message: "Reservation not found.",
        statusCode: 404,
      });
    }

    if (cancellationUpdate.count === 0) {
      return {
        reservation: persistedReservation,
        didCancel: false,
      };
    }

    if (
      persistedReservation.property.distributionEnabled === true &&
      persistedReservation.property.distributionStatus === "ACTIVE"
    ) {
      const propertyTimezone =
        persistedReservation.property.timezone ?? "America/Puerto_Rico";

      await persistChannexAriReservationIntent({
        db: tx,
        organizationId: persistedReservation.property.organizationId,
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
          requestedAt,
          propertyTimezone,
          "yyyy-MM-dd"
        ),
        now: requestedAt,
      });
    }

    return {
      reservation: persistedReservation,
      didCancel: true,
    };
  });

  const reservation = cancellationResult.reservation;

  if (!cancellationResult.didCancel) {
    return {
      ok: true,
      alreadyCancelled: true,
      reservation: {
        id: reservation.id,
        status: reservation.status,
        paymentState: reservation.paymentState,
        cancelledAt: reservation.cancelledAt,
        cancelledBy: reservation.cancelledBy,
        cancellationReason: reservation.cancellationReason,
      },
      operationalFinalization: {
        ok: true,
        skipped: true,
        errors: [],
      },
    };
  }

  const operationalFinalization =
    await finalizeManualCancellationOperationsSafe({
      reservationId: reservation.id,
      cancelledAt: reservation.cancelledAt ?? requestedAt,
    });

  return {
    ok: true,
    alreadyCancelled: false,
    reservation: {
      id: reservation.id,
      status: reservation.status,
      paymentState: reservation.paymentState,
      cancelledAt: reservation.cancelledAt,
      cancelledBy: reservation.cancelledBy,
      cancellationReason: reservation.cancellationReason,
    },
    operationalFinalization: {
      ...operationalFinalization,
      skipped: false,
    },
  };
}
