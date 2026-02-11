// src/integrations/twilio/twilio.client.ts
import Twilio from "twilio";

function cleanEnv(v?: string) {
  return (v ?? "")
    .replace(/^\uFEFF/, "")       // quita BOM si existe
    .trim()                       // quita espacios/saltos
    .replace(/^["']|["']$/g, ""); // quita comillas al inicio/fin
}

function getTwilioEnv() {
  const SID = cleanEnv(process.env.TWILIO_ACCOUNT_SID);
  const TOKEN = cleanEnv(process.env.TWILIO_AUTH_TOKEN);
  const FROM = cleanEnv(process.env.TWILIO_FROM_NUMBER);

  const missing = [
    ["TWILIO_ACCOUNT_SID", SID],
    ["TWILIO_AUTH_TOKEN", TOKEN],
    ["TWILIO_FROM_NUMBER", FROM],
  ].filter(([, v]) => !v).map(([k]) => k);

  if (missing.length) {
    throw new Error(`Missing Twilio env: ${missing.join(", ")}`);
  }

  // logs seguros para diagnosticar (no exponen secretos)
  console.log(
    `[Twilio] SID len=${SID.length} prefix=${SID.slice(0, 2)} hasSpace=${/\s/.test(SID)}`
  );
  console.log(
    `[Twilio] TOKEN len=${TOKEN.length} prefix=${TOKEN.slice(0, 2)} hasSpace=${/\s/.test(TOKEN)}`
  );
  console.log(
    `[Twilio] FROM len=${FROM.length} prefix=${FROM.slice(0, 2)} hasSpace=${/\s/.test(FROM)}`
  );

  return { SID, TOKEN, FROM };
}

export async function sendSms(to: string, body: string) {
  const { SID, TOKEN, FROM } = getTwilioEnv();

  const client = Twilio(SID, TOKEN);

  const msg = await client.messages.create({
    from: FROM,
    to,
    body,
  });

  return { sid: msg.sid, status: msg.status };
}
