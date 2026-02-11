import { PrismaClient } from "@prisma/client";
import { sendSms } from "../integrations/twilio/twilio.client";

const BASE_URL = (process.env.PUBLIC_BASE_URL ?? "http://localhost:3000").replace(/\/+$/, "");

function toErrString(e: unknown) {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  return String(e);
}

function buildGuestLink(token: string) {
  return `${BASE_URL}/checkin/${token}`;
}

export async function sendGuestAccessLinkSms(prisma: PrismaClient, reservationId: string, reason: "PAID" | "REMINDER") {
  const r = await prisma.reservation.findUnique({
    where: { id: reservationId },
    select: {
      id: true,
      guestName: true,
      guestPhone: true,
      roomName: true,
      checkIn: true,
      property: { select: { name: true } },
      guestToken: true,
      guestTokenExpiresAt: true,
    },
  });

  if (!r) return { ok: false, skipped: true, error: "Reservation not found" };
  if (!r.guestPhone) return { ok: false, skipped: true, error: "No guestPhone" };
  if (!r.guestToken) return { ok: false, skipped: true, error: "No guestToken" };

  const link = buildGuestLink(r.guestToken);
  const name = r.guestName ?? "Guest";
  const room = r.roomName ? ` • ${r.roomName}` : "";
  const prop = r.property?.name ?? "Propiedad";

  const prefix = reason === "PAID" ? "✅ Confirmación" : "⏰ Recordatorio";
  const body =
    `Pin&Go ${prefix}\n` +
    `${prop}${room}\n` +
    `Hola ${name}, aquí está tu link de acceso:\n` +
    `${link}\n` +
    `Check-in: ${new Date(r.checkIn).toLocaleString()}`;

  try {
    const sent = await sendSms(r.guestPhone, body);

    await prisma.messageLog.create({
      data: {
        channel: "sms",
        to: r.guestPhone,
        from: process.env.TWILIO_FROM_NUMBER ?? process.env.TWILIO_FROM ?? null,
        body,
        provider: "twilio",
        providerMessageId: (sent as any)?.sid ?? null,
        status: "SENT",
        accessGrantId: null,
      },
    });

    return { ok: true, skipped: false, link };
  } catch (e) {
    const msg = toErrString(e);

    await prisma.messageLog.create({
      data: {
        channel: "sms",
        to: r.guestPhone,
        from: process.env.TWILIO_FROM_NUMBER ?? process.env.TWILIO_FROM ?? null,
        body,
        provider: "twilio",
        providerMessageId: null,
        status: "FAILED",
        accessGrantId: null,
      },
    });

    return { ok: false, skipped: false, error: msg };
  }
}
