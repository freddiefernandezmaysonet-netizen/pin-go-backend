import type { PrismaClient } from "@prisma/client";
import { Resend } from "resend";
import { isDeepStrictEqual } from "node:util";
import { getEmailSender } from "../lib/email-senders.js";
import { deliverOtaOperationalCommunication } from "../channex-messaging/ota-operational-guest.service.js";
import { activeAppStayWhere } from "./ota-guest-app-activation.service.js";
import { guestAppVerificationChannel, guestAppVerificationText } from "./guest-app-verification-channel.policy.js";

type Input = { reservationId: string; challengeId: string; code: string };
type Email = { to: string; code: string; language: string | null; idempotencyKey: string };

export async function sendGuestAppVerificationEmail(input: Email): Promise<string> {
  const key = process.env.RESEND_API_KEY?.trim();
  if (!key) throw Error("GUEST_APP_VERIFICATION_EMAIL_UNCONFIGURED");
  const es = /^es/i.test(input.language ?? "");
  const subject = es ? "Pin&Go Guest · Verifica tu dispositivo" : "Pin&Go Guest · Verify your device";
  if (!/^\d{6}$/.test(input.code)) throw Error("GUEST_APP_VERIFICATION_CODE_INVALID");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = await Promise.race([
      new Resend(key).emails.send({
        from: getEmailSender("authentication"), to: input.to, subject,
        text: guestAppVerificationText(input.code, input.language, "EMAIL"),
        html: `<div style="max-width:520px;margin:auto;padding:32px;font-family:Arial,sans-serif;color:#0f172a"><h1>${subject}</h1><p>${es ? "Usa este código para autorizar la vinculación de tu reservación con la app:" : "Use this code to authorize linking your reservation with the app:"}</p><p style="font-size:36px;font-weight:700;letter-spacing:6px">${input.code}</p><p>${es ? "Vence en 10 minutos. No es el código de la puerta. No lo compartas con nadie, incluido el host." : "Expires in 10 minutes. This is not your door code. Do not share it with anyone, including your host."}</p><p>${es ? "Si no solicitaste activar un dispositivo, ignora este mensaje; no se le ha dado acceso." : "If you did not request to activate a device, ignore this message; access has not been granted."}</p></div>`,
      }, { idempotencyKey: input.idempotencyKey }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error("GUEST_APP_VERIFICATION_EMAIL_TIMEOUT")), 20_000); }),
    ]);
    if (response.error || !response.data?.id) throw Error("GUEST_APP_VERIFICATION_EMAIL_NOT_ACCEPTED");
    return response.data.id;
  } finally { if (timer) clearTimeout(timer); }
}

export async function deliverGuestAppVerification(prisma: PrismaClient, input: Input, dependencies: {
  sendEmail?: (input: Email) => Promise<string>;
  sendChannex?: typeof deliverOtaOperationalCommunication;
  now?: Date;
} = {}): Promise<boolean> {
  if (!/^[A-Za-z0-9_-]{32}$/.test(input.challengeId) || !/^\d{6}$/.test(input.code)) return false;
  const now = dependencies.now ?? new Date();
  const query = { where: { id: input.reservationId, ...activeAppStayWhere(now) }, select: {
    id: true, propertyId: true, source: true, externalProvider: true, externalId: true,
    guestEmail: true, preferredLanguage: true, property: { select: { organizationId: true } },
  } } as const;
  const stay = await prisma.reservation.findFirst(query);
  if (!stay) return false;
  const channel = guestAppVerificationChannel(stay);
  if (channel === "CHANNEX") {
    const result = await (dependencies.sendChannex ?? deliverOtaOperationalCommunication)(prisma, stay.id, "GUEST_APP_DEVICE_VERIFICATION", {
      activationVerification: { challengeId: input.challengeId, code: input.code },
    });
    return result?.ok === true;
  }
  if (channel !== "EMAIL") return false;
  const id = `guestappverify_${input.challengeId}`;
  const previous = await prisma.messageLog.findUnique({ where: { id } });
  if (previous) return previous.status === "SENT";
  if (!isDeepStrictEqual(stay, await prisma.reservation.findFirst(query))) return false;
  try {
    await prisma.messageLog.create({ data: {
      id, organizationId: stay.property.organizationId, propertyId: stay.propertyId, reservationId: stay.id,
      channel: "email", provider: "resend", communicationType: "GUEST_APP_DEVICE_VERIFICATION",
      to: stay.guestEmail!.trim(), from: getEmailSender("authentication"), status: "EMAIL_VERIFICATION_SENDING",
      body: "Pin&Go Guest device verification",
    } });
  } catch { return false; } // Concurrent or failed receipt claim never sends twice.
  try {
    const messageId = await (dependencies.sendEmail ?? sendGuestAppVerificationEmail)({
      to: stay.guestEmail!.trim(), code: input.code, language: stay.preferredLanguage, idempotencyKey: id,
    });
    if (!messageId) throw Error("GUEST_APP_VERIFICATION_EMAIL_ACK_MISSING");
    const saved = await prisma.messageLog.updateMany({ where: { id, status: "EMAIL_VERIFICATION_SENDING" },
      data: { status: "SENT", providerMessageId: messageId, error: null } });
    return saved.count === 1;
  } catch {
    await prisma.messageLog.updateMany({ where: { id, status: "EMAIL_VERIFICATION_SENDING" },
      data: { status: "EMAIL_VERIFICATION_UNKNOWN", error: "GUEST_APP_VERIFICATION_EMAIL_OUTCOME_UNKNOWN" } }).catch(() => {});
    return false;
  }
}
