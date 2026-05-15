import twilio from "twilio";

const enabled = (process.env.GUEST_SMS_ENABLED ?? "true").toLowerCase() === "true";

function normalizePhone(phone?: string | null) {
  if (!phone) return null;

  const raw = phone.trim();
  if (!raw) return null;

  if (raw.startsWith("+")) {
    return `+${raw.replace(/\D/g, "")}`;
  }

  const digits = raw.replace(/\D/g, "");

  if (!digits) return null;

  if (digits.length === 10) {
    return `+1${digits}`;
  }

  if (digits.length === 11 && digits.startsWith("1")) {
    return `+${digits}`;
  }

  return `+${digits}`;
}

export async function sendGuestSms(toRaw: string | null | undefined, message: string) {
  if (!enabled) return { skipped: true, reason: "GUEST_SMS_ENABLED=false" };

  const to = normalizePhone(toRaw);
  if (!to) return { skipped: true, reason: "missing phone" };

  const accountSid = process.env.TWILIO_ACCOUNT_SID ?? "";
  const apiKey = process.env.TWILIO_API_KEY ?? "";
  const apiSecret = process.env.TWILIO_API_SECRET ?? "";
  const from =
  process.env.TWILIO_FROM_NUMBER ??
  process.env.TWILIO_SMS_FROM ??
  process.env.TWILIO_FROM ??
  "";

  if (!accountSid || !apiKey || !apiSecret || !from) {
    throw new Error(
      "Missing Twilio env vars (TWILIO_ACCOUNT_SID/TWILIO_API_KEY/TWILIO_API_SECRET/TWILIO_FROM_NUMBER)"
    );
  }

  const client = twilio(apiKey, apiSecret, { accountSid });
  const resp = await client.messages.create({ from, to, body: message });

  return { skipped: false, sid: resp.sid };
}