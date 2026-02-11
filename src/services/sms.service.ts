import twilio from "twilio";

const enabled = (process.env.GUEST_SMS_ENABLED ?? "true").toLowerCase() === "true";

function normalizePhone(phone?: string | null) {
  if (!phone) return null;
  // asume que ya viene en E.164 (+1787..., +1217..., etc.)
  // si no, aquí puedes normalizar a +1...
  return phone.trim();
}

export async function sendGuestSms(toRaw: string | null | undefined, message: string) {
  if (!enabled) return { skipped: true, reason: "GUEST_SMS_ENABLED=false" };

  const to = normalizePhone(toRaw);
  if (!to) return { skipped: true, reason: "missing phone" };

  const sid = process.env.TWILIO_ACCOUNT_SID ?? "";
  const token = process.env.TWILIO_AUTH_TOKEN ?? "";
  const from = process.env.TWILIO_FROM ?? "";

  if (!sid || !token || !from) {
    throw new Error("Missing Twilio env vars (TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN/TWILIO_FROM)");
  }

  const client = twilio(sid, token);
  const resp = await client.messages.create({ from, to, body: message });
  return { skipped: false, sid: resp.sid };
}
