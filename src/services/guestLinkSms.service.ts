import { PrismaClient } from "@prisma/client";
import { sendSms } from "../integrations/twilio/twilio.client";
import { buildGuestLink } from "./guestToken";

function toErrString(e: unknown) {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  return String(e);
}

function maskSensitiveBody(body: string) {
  if (!body) return body;

  let masked = body;

  // Enmascara posibles passcodes numéricos
  masked = masked.replace(/\b\d{4,10}\b/g, (match) => {
    if (match.length <= 2) return "**";
    return `${"*".repeat(Math.max(match.length - 2, 4))}${match.slice(-2)}`;
  });

  // Enmascara guest link
  masked = masked.replace(
    /(https?:\/\/[^\s]*\/guest\/access\/)([A-Za-z0-9\-_]+)/gi,
    (_m, prefix, token) => `${prefix}${String(token).slice(0, 4)}****`
  );

  return masked;
}

export async function sendGuestAccessLinkSms(
  prisma: PrismaClient,
  reservationId: string,
  reason: "PAID" | "REMINDER"
) {
  const r = await prisma.reservation.findUnique({
    where: { id: reservationId },
    select: {
      id: true,
      guestName: true,
      guestPhone: true,
      guestToken: true,
      guestTokenExpiresAt: true,
      property: {
        select: {
          id: true,
          organizationId: true,
          name: true,
        },
      },
    },
  });

  if (!r) {
    return { ok: false, skipped: true, error: "Reservation not found" };
  }

  if (!r.guestPhone) {
    return { ok: false, skipped: true, error: "No guestPhone" };
  }

  if (!r.guestToken) {
    return { ok: false, skipped: true, error: "No guestToken" };
  }

  const link = buildGuestLink(r.guestToken);
  const propertyName = r.property?.name ?? "your property";
  const guestName = (r.guestName ?? "").trim();

  const greetingEs = guestName ? `Hola ${guestName},` : "Hola,";
  const greetingEn = guestName ? `Hi ${guestName},` : "Hi,";

  const introEs =
    reason === "PAID"
      ? `Tu reserva en ${propertyName} ha sido confirmada.`
      : `Te recordamos tu check-in en ${propertyName}.`;

  const introEn =
    reason === "PAID"
      ? `Your reservation at ${propertyName} has been confirmed.`
      : `Reminder: your check-in at ${propertyName} is coming up.`;

  // ✅ MENSAJE BILINGÜE COMPLETO
  const es = `${greetingEs}

${introEs}

🔐 Acceso a tu estadía:
${link}

Utiliza este enlace para generar tu código de acceso temporal.

🕒 El código es de un solo uso y tendrá una duración limitada (aprox. 6 horas).

📲 Durante tu estadía, el acceso continuo estará disponible mediante tarjetas NFC dentro de la propiedad.

Este enlace es personal y no debe compartirse.

Si tienes algún inconveniente, responde a este mensaje.`;

  const en = `${greetingEn}

${introEn}

🔐 Access to your stay:
${link}

Use this link to generate your temporary access code.

🕒 The code is single-use and will remain valid for a limited time (approx. 6 hours).

📲 During your stay, continuous access will be available via NFC cards inside the property.

This link is personal and should not be shared.

If you have any issues, reply to this message.`;

  const body = `${es}

---

${en}`;

  const safeBody = maskSensitiveBody(body);

  try {
    const sent = await sendSms(r.guestPhone, body);

    await prisma.messageLog.create({
      data: {
        channel: "sms",
        to: r.guestPhone,
        from: process.env.TWILIO_FROM_NUMBER ?? process.env.TWILIO_FROM ?? null,
        body: safeBody,
        provider: "twilio",
        providerMessageId: (sent as any)?.sid ?? null,
        status: "SENT",
        reservationId: r.id,
        propertyId: r.property?.id ?? null,
        organizationId: r.property?.organizationId ?? null,
      },
    });

    return {
      ok: true,
      sid: (sent as any)?.sid ?? null,
    };
  } catch (e) {
    const err = toErrString(e);

    await prisma.messageLog.create({
      data: {
        channel: "sms",
        to: r.guestPhone,
        from: process.env.TWILIO_FROM_NUMBER ?? process.env.TWILIO_FROM ?? null,
        body: safeBody,
        provider: "twilio",
        providerMessageId: null,
        status: "FAILED",
        error: err,
        reservationId: r.id,
        propertyId: r.property?.id ?? null,
        organizationId: r.property?.organizationId ?? null,
      },
    });

    return {
      ok: false,
      error: err,
    };
  }
}