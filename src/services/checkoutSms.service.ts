import { PrismaClient } from "@prisma/client";
import { sendSms } from "../integrations/twilio/twilio.client";

function buildCheckoutMessage(input: {
  guestName?: string | null;
  propertyName: string;
  checkoutTime: string;
}) {
  const guestName = String(input.guestName ?? "").trim();
  const greetingEs = guestName ? `Hola ${guestName},` : "Hola,";
  const greetingEn = guestName ? `Hi ${guestName},` : "Hi,";

  const es = `${greetingEs}

Tu check-out de ${input.propertyName} ha sido procesado correctamente a las ${input.checkoutTime}.

Antes de salir:
- Cierra puertas y ventanas
- Apaga luces y aire acondicionado

Gracias por tu estadía.
Te esperamos nuevamente.`;

  const en = `${greetingEn}

Your check-out from ${input.propertyName} has been completed at ${input.checkoutTime}.

Before leaving:
- Close doors and windows
- Turn off lights and AC

Thank you for your stay.
We hope to host you again.`;

  return `${es}

---

${en}`;
}

export async function sendCheckoutSms(
  prisma: PrismaClient,
  reservationId: string
) {
  try {
    // ✅ idempotencia real: solo bloquear si ya fue enviado exitosamente
    const existing = await prisma.messageDispatchLog.findFirst({
      where: {
        reservationId,
        type: "CHECKOUT",
        status: "SENT",
      },
    });

    if (existing) {
      return { ok: true, skipped: true };
    }

    const r = await prisma.reservation.findUnique({
      where: { id: reservationId },
      select: {
        id: true,
        guestName: true,
        guestPhone: true,
        checkOut: true,
        property: {
          select: {
            id: true,
            organizationId: true,
            name: true,
            timezone: true,
          },
        },
      },
    });

    if (!r || !r.guestPhone) {
      return { ok: false, skipped: true, error: "Missing guestPhone" };
    }

    const propertyName = r.property?.name ?? "your property";

   const checkoutTime = new Intl.DateTimeFormat("en-US", {
  timeZone: r.property?.timezone ?? "UTC",
  hour: "2-digit",
  minute: "2-digit",
  hour12: true,
}).format(new Date(r.checkOut));

    const body = buildCheckoutMessage({
      guestName: r.guestName,
      propertyName,
      checkoutTime,
    });

    const sent = await sendSms(r.guestPhone, body);

    await prisma.messageLog.create({
      data: {
        channel: "sms",
        to: r.guestPhone,
        from: process.env.TWILIO_FROM_NUMBER ?? null,
        body,
        provider: "twilio",
        providerMessageId: (sent as any)?.sid ?? null,
        status: "SENT",
        reservationId: r.id,
        propertyId: r.property?.id ?? null,
        organizationId: r.property?.organizationId ?? null,
      },
    });

    await prisma.messageDispatchLog.create({
      data: {
        reservationId: r.id,
        type: "CHECKOUT",
        channel: "sms",
        status: "SENT",
      },
    });

    return { ok: true };
  } catch (e: any) {
    console.error("[checkoutSms] failed", e);

    try {
      const r = await prisma.reservation.findUnique({
        where: { id: reservationId },
        select: {
          id: true,
          guestPhone: true,
          property: {
            select: {
              id: true,
              organizationId: true,
            },
          },
        },
      });

      if (r?.guestPhone) {
        await prisma.messageLog.create({
          data: {
            channel: "sms",
            to: r.guestPhone,
            from: process.env.TWILIO_FROM_NUMBER ?? null,
            body: "[CHECKOUT SMS FAILED BEFORE LOG BODY COULD BE PERSISTED]",
            provider: "twilio",
            providerMessageId: null,
            status: "FAILED",
            error: e?.message ?? "unknown_error",
            reservationId: r.id,
            propertyId: r.property?.id ?? null,
            organizationId: r.property?.organizationId ?? null,
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
          type: "CHECKOUT",
          channel: "sms",
          status: "FAILED",
        },
      });
    } catch {
      // no-op
    }

    return { ok: false, error: e?.message ?? "unknown_error" };
  }
}