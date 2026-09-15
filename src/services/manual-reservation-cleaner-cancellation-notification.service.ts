import { PrismaClient, ReservationStatus } from "@prisma/client";
import { sendSms } from "../integrations/twilio/twilio.client";

const prisma = new PrismaClient();

const DISPATCH_TYPE =
  "MANUAL_RESERVATION_CLEANER_CANCELLATION";

export type NotifyCleanerOfManualReservationCancellationInput = {
  reservationId: string;
  prisma?: PrismaClient;
};

function toGsmSafeManualCleanerCancellationText(
  value: unknown,
  maxLength: number
) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[–—]/g, "-")
    .replace(/[^A-Za-z0-9 .,&'()#*+/:;?%-]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function formatCompactStayDate(
  value: Date,
  timeZone: string
) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  })
    .format(value)
    .replace(",", "")
    .replace(/\s+/g, " ")
    .trim();
}

export function buildManualCleanerCancellationSmsBody(input: {
  reservationNumber: string;
  propertyName: string;
  checkIn: Date;
  checkOut: Date;
  timeZone: string;
}) {
  const reservationNumber =
    toGsmSafeManualCleanerCancellationText(input.reservationNumber, 24) ||
    "N/A";
  const propertyName =
    toGsmSafeManualCleanerCancellationText(input.propertyName, 20) ||
    "Property";
  const checkIn = toGsmSafeManualCleanerCancellationText(
    formatCompactStayDate(input.checkIn, input.timeZone),
    16
  );
  const checkOut = toGsmSafeManualCleanerCancellationText(
    formatCompactStayDate(input.checkOut, input.timeZone),
    16
  );

  return (
    `Pin&Go clean cancelled/cancelada. ` +
    `Res: ${reservationNumber}. ` +
    `Prop: ${propertyName}. ` +
    `Stay: ${checkIn}-${checkOut}. ` +
    `No cleaning/no limpieza.`
  );
}

export async function notifyCleanerOfManualReservationCancellation({
  reservationId,
  prisma: inputPrisma,
}: NotifyCleanerOfManualReservationCancellationInput) {
  const db = inputPrisma ?? prisma;
  const cleanReservationId = String(
    reservationId ?? ""
  ).trim();

  if (!cleanReservationId) {
    return {
      ok: false,
      skipped: true,
      reason: "missing_reservation_id",
    };
  }

  const reservation = await db.reservation.findUnique({
    where: {
      id: cleanReservationId,
    },
    include: {
      property: {
        select: {
          id: true,
          name: true,
          timezone: true,
          organizationId: true,
        },
      },
    },
  });

  if (!reservation) {
    return {
      ok: false,
      skipped: true,
      reason: "reservation_not_found",
    };
  }

  const isManualReservation =
    String(reservation.source ?? "")
      .trim()
      .toUpperCase() === "MANUAL" &&
    String(reservation.externalProvider ?? "")
      .trim()
      .toUpperCase() === "PIN_GO_MANUAL";

  if (
    !isManualReservation ||
    reservation.status !== ReservationStatus.CANCELLED
  ) {
    return {
      ok: false,
      skipped: true,
      reason: "not_cancelled_manual_reservation",
    };
  }

  const [confirmation, staffAssignment] =
    await Promise.all([
      db.cleaningConfirmation.findFirst({
        where: {
          reservationId: reservation.id,
          status: {
            in: [
              "PENDING",
              "CONFIRMED",
              "CANCELLED",
            ],
          },
        },
        orderBy: {
          updatedAt: "desc",
        },
      }),
      db.staffAssignment.findFirst({
        where: {
          reservationId: reservation.id,
        },
        orderBy: {
          updatedAt: "desc",
        },
      }),
    ]);

  const staffMemberId =
    confirmation?.staffMemberId ??
    staffAssignment?.staffMemberId ??
    null;

  if (!staffMemberId) {
    return {
      ok: true,
      skipped: true,
      reason: "no_cleaner_assignment",
    };
  }

  const staff = await db.staffMember.findFirst({
    where: {
      id: staffMemberId,
      organizationId:
        reservation.property.organizationId,
    },
  });

  if (!staff?.phoneE164) {
    return {
      ok: true,
      skipped: true,
      reason: "cleaner_phone_not_available",
    };
  }

  const alreadySent =
    await db.messageDispatchLog.findFirst({
      where: {
        reservationId: reservation.id,
        type: DISPATCH_TYPE,
        channel: "sms",
        status: "SENT",
      },
      orderBy: {
        createdAt: "desc",
      },
    });

  if (alreadySent) {
    return {
      ok: true,
      skipped: true,
      reason: "already_notified",
    };
  }

  const timeZone =
    reservation.property.timezone ??
    "America/Puerto_Rico";
  const propertyName =
    reservation.property.name ??
    reservation.roomName ??
    "Assigned property";
  const reservationNumber =
    reservation.reservationNumber ??
    reservation.id;
  const body = buildManualCleanerCancellationSmsBody({
    reservationNumber: String(reservationNumber),
    propertyName,
    checkIn: reservation.checkIn,
    checkOut: reservation.checkOut,
    timeZone,
  });

  try {
    const sms = await sendSms(
      staff.phoneE164,
      body
    );

    await db.$transaction([
      db.messageLog.create({
        data: {
          channel: "sms",
          to: staff.phoneE164,
          from:
            process.env.TWILIO_FROM_NUMBER ??
            null,
          body,
          provider: "twilio",
          providerMessageId:
            (sms as any)?.sid ?? null,
          status: "SENT",
          reservationId: reservation.id,
          propertyId: reservation.propertyId,
          organizationId:
            reservation.property.organizationId,
        },
      }),
      db.messageDispatchLog.create({
        data: {
          reservationId: reservation.id,
          type: DISPATCH_TYPE,
          channel: "sms",
          status: "SENT",
        },
      }),
    ]);

    return {
      ok: true,
      skipped: false,
      reason: "cleaner_notified",
    };
  } catch (error: any) {
    const errorMessage = String(
      error?.message ?? error
    );

    await db.messageLog
      .create({
        data: {
          channel: "sms",
          to: staff.phoneE164,
          from:
            process.env.TWILIO_FROM_NUMBER ??
            null,
          body,
          provider: "twilio",
          providerMessageId: null,
          status: "FAILED",
          error: errorMessage,
          reservationId: reservation.id,
          propertyId: reservation.propertyId,
          organizationId:
            reservation.property.organizationId,
        },
      })
      .catch(() => {});

    await db.messageDispatchLog
      .create({
        data: {
          reservationId: reservation.id,
          type: DISPATCH_TYPE,
          channel: "sms",
          status: "FAILED",
        },
      })
      .catch(() => {});

    return {
      ok: false,
      skipped: false,
      reason: "cleaner_notification_failed",
      error: errorMessage,
    };
  }
}
