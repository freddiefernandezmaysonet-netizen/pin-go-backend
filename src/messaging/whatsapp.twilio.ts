import "dotenv/config";
import twilio from "twilio";

const accountSid = process.env.TWILIO_ACCOUNT_SID!;
const apiKey = process.env.TWILIO_API_KEY!;
const apiSecret = process.env.TWILIO_API_SECRET!;
const from = process.env.TWILIO_WHATSAPP_FROM!; // format: whatsapp:+XXXXXXXXXXX

const client = twilio(apiKey, apiSecret, {
  accountSid,
});

export async function sendWhatsApp(toE164: string, body: string) {
  const to = `whatsapp:${toE164}`;

  const msg = await client.messages.create({
    from,
    to,
    body,
  });

  return { sid: msg.sid, status: msg.status };
}