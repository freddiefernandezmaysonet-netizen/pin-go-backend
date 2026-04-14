import { PrismaClient } from "@prisma/client";
import { sendSms } from "../integrations/twilio/twilio.client";

export async function sendCleaningReadySms(
  prisma: PrismaClient,
  reservationId: string
) {
  try {
    const existing = await prisma.messageDispatchLog.findFirst({
      where: {
        reservationId,
        type: "CLEANING_READY",
        status: "SENT",
      },
    });

    if (existing) {
      return { ok: true, skipped: true };
    }

    const assignment = await prisma.staffAssignment.findFirst({
      where: {
        reservationId,
      },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        startsAt: true,
        endsAt: true,
        reservation: {
          select: {
            id: true,
            roomName: true,
            property: {
              select: {
                id: true,
                organizationId: true,
                name: true,
              },
            },
          },
        },
        staffMember: {
          select: {
            fullName: true,
            phoneE164: true,
          },
        },
      },
    });

    if (!assignment?.staffMember?.phoneE164) {
      return { ok: false, skipped: true, error: "Missing cleaner phone" };
    }

    const propertyName = assignment.reservation?.property?.name ?? "Property";
    const roomName = assignment.reservation?.roomName ?? "N/A";
    const staffName = assignment.staffMember.fullName ?? "Staff";

    const start = new Date(assignment.startsAt).toLocaleString();
    const end = new Date(assignment.endsAt).toLocaleString();

    const es =
      `🧼 Pin&Go Limpieza lista para comenzar \n` +
      `Asignado: ${staffName}\n` +
      `Propiedad: ${propertyName}\n` +
      `Unidad: ${roomName}\n` +
      `Ventana: ${start} - ${end}\n` +
      `La propiedad está lista para limpieza.`;

    const en =
      `🧼 Pin&Go Cleaning ready to start\n` +
      `Assigned: ${staffName}\n` +
      `Property: ${propertyName}\n` +
      `Unit: ${roomName}\n` +
      `Window: ${start} - ${end}\n` +
      `The property is now ready for cleaning.`;

    const body = `${es}\n\n---\n\n${en}`;

    const sent = await sendSms(assignment.staffMember.phoneE164, body);

    await prisma.messageLog.create({
      data: {
        channel: "sms",
        to: assignment.staffMember.phoneE164,
        from: process.env.TWILIO_FROM_NUMBER ?? null,
        body,
        provider: "twilio",
        providerMessageId: (sent as any)?.sid ?? null,
        status: "SENT",
        reservationId: assignment.reservation?.id ?? reservationId,
        propertyId: assignment.reservation?.property?.id ?? null,
        organizationId: assignment.reservation?.property?.organizationId ?? null,
      },
    });

    await prisma.messageDispatchLog.create({
      data: {
        reservationId,
        type: "CLEANING_READY",
        channel: "sms",
        status: "SENT",
      },
    });

    return { ok: true };
  } catch (e: any) {
    console.error("[cleaningReadySms] failed", e);

    try {
      const assignment = await prisma.staffAssignment.findFirst({
        where: {
          reservationId,
        },
        orderBy: { createdAt: "asc" },
        select: {
          reservation: {
            select: {
              id: true,
              property: {
                select: {
                  id: true,
                  organizationId: true,
                },
              },
            },
          },
          staffMember: {
            select: {
              phoneE164: true,
            },
          },
        },
      });

      if (assignment?.staffMember?.phoneE164) {
        await prisma.messageLog.create({
          data: {
            channel: "sms",
            to: assignment.staffMember.phoneE164,
            from: process.env.TWILIO_FROM_NUMBER ?? null,
            body: "[CLEANING_READY SMS FAILED BEFORE LOG BODY COULD BE PERSISTED]",
            provider: "twilio",
            providerMessageId: null,
            status: "FAILED",
            error: e?.message ?? "unknown_error",
            reservationId: assignment.reservation?.id ?? reservationId,
            propertyId: assignment.reservation?.property?.id ?? null,
            organizationId: assignment.reservation?.property?.organizationId ?? null,
          },
        });
      }
    } catch {
      // no-op
    }

    try {
      await prisma.messageDispatchLog.create({
        data: {
          reservationId,
          type: "CLEANING_READY",
          channel: "sms",
          status: "FAILED",
        },
      });
    } catch {}

    return { ok: false, error: e?.message ?? "unknown_error" };
  }
}