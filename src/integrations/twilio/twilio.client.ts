import { deliveryAccountBindingEnabled } from "../../services/message-delivery-account-binding.service";
// src/integrations/twilio/twilio.client.ts
import Twilio from "twilio";

function cleanEnv(v?: string) {
  return (v ?? "")
    .replace(/^\uFEFF/, "")       // quita BOM si existe
    .trim()                       // quita espacios/saltos
    .replace(/^["']|["']$/g, ""); // quita comillas al inicio/fin
}

type CanarySmsScope = { organizationId: string; propertyId: string; reservationId: string };

export function resolveTwilioStatusCallback(
  env: NodeJS.ProcessEnv = process.env,
  scope?: CanarySmsScope,
  to?: string,
): string | null {
  const scopedCallback = env.GUEST_JOURNEY_CANARY_SMS_CALLBACK_ENABLED === "1" &&
    env.GUEST_JOURNEY_CANARY_EXECUTE === "1" &&
    !!scope?.organizationId && scope.organizationId === env.GUEST_JOURNEY_CANARY_ORGANIZATION_ID &&
    !!scope.propertyId && scope.propertyId === env.GUEST_JOURNEY_CANARY_PROPERTY_ID &&
    !!scope.reservationId && scope.reservationId === env.GUEST_JOURNEY_CANARY_RESERVATION_ID &&
    !!to && to === env.GUEST_JOURNEY_CANARY_SMS;

  if (env.MESSAGE_DELIVERY_WEBHOOKS_ENABLED !== "1" && !scopedCallback) {
    return null;
  }

  if (!cleanEnv(env.TWILIO_AUTH_TOKEN)) {
    return null;
  }

  const raw =
    cleanEnv(env.PUBLIC_API_BASE_URL) ||
    cleanEnv(env.API_BASE_URL) ||
    cleanEnv(env.PUBLIC_BASE_URL);

  if (!raw) return null;

  try {
    const url = new URL(raw);

    if (
      env.NODE_ENV === "production" &&
      url.protocol !== "https:"
    ) {
      return null;
    }

    return (
      url.toString().replace(/\/+$/, "") +
      "/webhooks/delivery/twilio"
    );
  } catch {
    return null;
  }
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

export async function sendSms(to: string, body: string, scope?: CanarySmsScope) {
  const { ACCOUNT_SID, API_KEY, API_SECRET, FROM } = getTwilioEnv();
  const bindAccount = deliveryAccountBindingEnabled();
  if (bindAccount && !/^AC[a-f0-9]{32}$/i.test(ACCOUNT_SID)) throw Error("DELIVERY_ACCOUNT_SID_INVALID");

  const client = Twilio(API_KEY, API_SECRET, {
    accountSid: ACCOUNT_SID,
  });

  const statusCallback =
    resolveTwilioStatusCallback(process.env, scope, to);

  const msg = await client.messages.create({
    from: FROM,
    to,
    body,
    ...(statusCallback
      ? { statusCallback }
      : {}),
  });

  return { sid: msg.sid, status: msg.status, ...(bindAccount ? { deliveryAccountKey: ACCOUNT_SID } : {}) };
}
