import Twilio from "twilio";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const sid = process.env.TWILIO_ACCOUNT_SID;
const token = process.env.TWILIO_AUTH_TOKEN;

const smsFrom = process.env.TWILIO_SMS_FROM;
const waFrom = process.env.TWILIO_WHATSAPP_FROM;
const channel = (process.env.NOTIFY_CHANNEL ?? "sms").toLowerCase();

if (!sid || !token) {
  console.warn("⚠️ Twilio credentials missing");
}

const client = sid && token ? Twilio(sid, token) : null;

type SendArgs = {
  toPhoneE164: string;
  body: string;
  accessGrantId?: string;
};

function normalizeTo(ch: string, to: string) {
  if (ch === "whatsapp") return `whatsapp:${to}`;
  return to;
}

export async function sendMessage({ toPhoneE164, body, accessGrantId }: SendArgs) {
  if (!client) throw new Error("Twilio client not initialized");
  if (!toPhoneE164?.startsWith("+")) throw new Error("Phone must be E.164 (+1...)");

  const use = channel === "whatsapp" ? "whatsapp" : "sms";
  const from = use === "whatsapp" ? waFrom : smsFrom;

  if (!from) throw new Error(`Missing TWILIO_${use === "whatsapp" ? "WHATSAPP" : "SMS"}_FROM`);

  const msg = await client.messages.create({
    from,
    to: normalizeTo(use, toPhoneE164),
    body,
  });

  // Guardar MessageLog (no rompe si accessGrantId es null)
  await prisma.messageLog.create({
    data: {
      channel: use,
      to: toPhoneE164,
      from,
      body,
      provider: "twilio",
      providerMessageId: msg.sid,
      status: msg.status,
      accessGrantId: accessGrantId ?? null,
    },
  });

  return { sid: msg.sid, status: msg.status };
}
