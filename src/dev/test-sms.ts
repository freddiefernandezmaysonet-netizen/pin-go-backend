import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import { sendSms } from "../integrations/twilio/twilio.client";

console.log("SID RAW:", process.env.TWILIO_ACCOUNT_SID);
console.log("TOKEN RAW:", process.env.TWILIO_AUTH_TOKEN);
console.log("FROM RAW:", process.env.TWILIO_FROM_NUMBER);

async function main() {
  const res = await sendSms("+17874294117", "Prueba Pin&Go SMS");
  console.log("SMS OK", res);
}

main().catch((e) => {
  console.error("SMS FAILED", e);
  process.exit(1);
});