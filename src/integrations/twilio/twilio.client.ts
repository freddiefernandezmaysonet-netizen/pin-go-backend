// src/integrations/twilio/twilio.client.ts
import Twilio from "twilio";

function cleanEnv(v?: string) {
  return (v ?? "")
    .replace(/^\uFEFF/, "")       // quita BOM si existe
    .trim()                       // quita espacios/saltos
    .replace(/^["']|["']$/g, ""); // quita comillas al inicio/fin
}

function getTwilioEnv() {
  const ACCOUNT_SID = cleanEnv(process.env.TWILIO_ACCOUNT_SID);
  const API_KEY = cleanEnv(process.env.TWILIO_API_KEY);
  const API_SECRET = cleanEnv(process.env.TWILIO_API_SECRET);
  const FROM = cleanEnv(process.env.TWILIO_FROM_NUMBER);

  const missing = [
    ["TWILIO_ACCOUNT_SID", ACCOUNT_SID],
    ["TWILIO_API_KEY", API_KEY],
    ["TWILIO_API_SECRET", API_SECRET],
    ["TWILIO_FROM_NUMBER", FROM],
  ]
    .filter(([, v]) => !v)
    .map(([k]) => k);

  if (missing.length) {
    throw new Error(`Missing Twilio env: ${missing.join(", ")}`);
  }

  // logs seguros para diagnosticar (no exponen secretos)
  console.log(
    `[Twilio] ACCOUNT_SID len=${ACCOUNT_SID.length} prefix=${ACCOUNT_SID.slice(0, 2)} hasSpace=${/\s/.test(ACCOUNT_SID)}`
  );
  console.log(
    `[Twilio] API_KEY len=${API_KEY.length} prefix=${API_KEY.slice(0, 2)} hasSpace=${/\s/.test(API_KEY)}`
  );
  console.log(
    `[Twilio] API_SECRET len=${API_SECRET.length} hasSpace=${/\s/.test(API_SECRET)}`
  );
  console.log(
    `[Twilio] FROM len=${FROM.length} prefix=${FROM.slice(0, 2)} hasSpace=${/\s/.test(FROM)}`
  );

  return { ACCOUNT_SID, API_KEY, API_SECRET, FROM };
}

export async function sendSms(to: string, body: string) {
  const { ACCOUNT_SID, API_KEY, API_SECRET, FROM } = getTwilioEnv();

  const client = Twilio(API_KEY, API_SECRET, {
    accountSid: ACCOUNT_SID,
  });

  const msg = await client.messages.create({
    from: FROM,
    to,
    body,
  });

  return { sid: msg.sid, status: msg.status };
}