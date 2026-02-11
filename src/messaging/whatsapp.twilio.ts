import "dotenv/config";
import twilio from "twilio";

const sid = process.env.TWILIO_ACCOUNT_SID!;
const token = process.env.TWILIO_AUTH_TOKEN!;
const from = process.env.TWILIO_WHATSAPP_FROM!; // format: whatsapp:+XXXXXXXXXXX

const client = twilio(sid, token);

export async function sendWhatsApp(toE164: string, body: string) {
  // toE164 ejemplo: +1787...
  const to = `whatsapp:${toE164}`;

  const msg = await client.messages.create({
    from,
    to,
    body,
  });

  return { sid: msg.sid, status: msg.status };
}
