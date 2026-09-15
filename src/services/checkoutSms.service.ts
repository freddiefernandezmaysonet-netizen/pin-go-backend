import { PrismaClient } from "@prisma/client";
import { sendSms } from "../integrations/twilio/twilio.client";
import {
  getGuestIntlLocale,
  resolveGuestLanguage,
  type GuestLanguage,
} from "./guest-language.service";
import { hasGuestSmsConsent } from "./guest-journey-access-communications-bridge.policy";

function toGsmSafeCheckoutText(value: unknown, maxLength: number) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[–—]/g, "-")
    .replace(/[^A-Za-z0-9 .,&'()#*+/:;-]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

export function buildCheckoutMessage(input: {
  guestName?: string | null;
  propertyName: string;
  checkoutTime: string;
  language: GuestLanguage;
}) {
  const propertyName =
    toGsmSafeCheckoutText(input.propertyName, 24) ||
    (input.language === "es" ? "propiedad" : "property");
  const checkoutTime =
    toGsmSafeCheckoutText(input.checkoutTime, 20) ||
    "checkout";

  if (input.language === "es") {
    return `Pin&Go: Check-out ${propertyName} completado a las ${checkoutTime}. Cierra puertas/ventanas y apaga luces/AC. Gracias por tu estadia.`;
  }

  return `Pin&Go: Check-out ${propertyName} completed at ${checkoutTime}. Close doors/windows and turn off lights/AC. Thank you.`;
}

export async function sendCheckoutSms(
  prisma: PrismaClient,
  reservationId: string
) {
  let retryBody: string | null = null;
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
        preferredLanguage: true,
        checkOut: true,
        externalRaw: true,
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

    if (process.env.GUEST_SMS_ENABLED !== "1") {
      return {
        ok: true,
        skipped: true,
        reason: "GUEST_SMS_DISABLED",
      };
    }

    if (!hasGuestSmsConsent(r.externalRaw)) {
      return {
        ok: true,
        skipped: true,
        reason: "SMS_CONSENT_NOT_GRANTED",
      };
    }

    const propertyName = r.property?.name ?? "your property";

    const language = resolveGuestLanguage(r.preferredLanguage);

   const checkoutTime = new Intl.DateTimeFormat(getGuestIntlLocale(language), {
  timeZone: r.property?.timezone ?? "UTC",
  hour: "2-digit",
  minute: "2-digit",
  hour12: true,
}).format(new Date(r.checkOut));

    const body = buildCheckoutMessage({
      guestName: r.guestName,
      propertyName,
      checkoutTime,
      language,
    });
    retryBody = body;

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
        communicationType: "CHECKOUT",
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
            body: retryBody ?? "[CHECKOUT SMS FAILED BEFORE LOG BODY COULD BE PERSISTED]",
            provider: "twilio",
            providerMessageId: null,
            status: "FAILED",
            error: e?.message ?? "unknown_error",
            reservationId: r.id,
            propertyId: r.property?.id ?? null,
            organizationId: r.property?.organizationId ?? null,
            communicationType: "CHECKOUT",
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
