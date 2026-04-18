import Twilio from "twilio";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const apiKey = process.env.TWILIO_API_KEY;
const apiSecret = process.env.TWILIO_API_SECRET;

const smsFrom = process.env.TWILIO_SMS_FROM;
const waFrom = process.env.TWILIO_WHATSAPP_FROM;
const channel = (process.env.NOTIFY_CHANNEL ?? "sms").toLowerCase();

if (!accountSid || !apiKey || !apiSecret) {
  console.warn("⚠️ Twilio credentials missing");
}

const client =
  accountSid && apiKey && apiSecret
    ? Twilio(apiKey, apiSecret, { accountSid })
    : null;

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