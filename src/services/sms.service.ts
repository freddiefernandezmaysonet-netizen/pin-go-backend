import twilio from "twilio";

const enabled = (process.env.GUEST_SMS_ENABLED ?? "true").toLowerCase() === "true";

function normalizePhone(phone?: string | null) {
  if (!phone) return null;
  return phone.trim();
}

export async function sendGuestSms(toRaw: string | null | undefined, message: string) {
  if (!enabled) return { skipped: true, reason: "GUEST_SMS_ENABLED=false" };

  const to = normalizePhone(toRaw);
  if (!to) return { skipped: true, reason: "missing phone" };

  const accountSid = process.env.TWILIO_ACCOUNT_SID ?? "";
  const apiKey = process.env.TWILIO_API_KEY ?? "";
  const apiSecret = process.env.TWILIO_API_SECRET ?? "";
  const from = process.env.TWILIO_FROM ?? "";

  if (!accountSid || !apiKey || !apiSecret || !from) {
    throw new Error(
      "Missing Twilio env vars (TWILIO_ACCOUNT_SID/TWILIO_API_KEY/TWILIO_API_SECRET/TWILIO_FROM)"
    );
  }

  const client = twilio(apiKey, apiSecret, { accountSid });
  const resp = await client.messages.create({ from, to, body: message });

  return { skipped: false, sid: resp.sid };
}