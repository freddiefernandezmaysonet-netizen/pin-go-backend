import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import type { ProviderDeliveryOutcome } from "./guest-journey-communications-delivery-outcome.service";

type VerifiedContext = { eventId?: string; accountSid?: string };
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

// This service is called only AFTER provider-signature verification. Capture is
// opt-in and does not authorize replay, ownership changes, or any new send.
export async function captureVerifiedDeliveryReceipt(
  db: Pick<PrismaClient, "messageDeliveryReceipt">,
  outcome: ProviderDeliveryOutcome,
  context: VerifiedContext,
  env: NodeJS.ProcessEnv = process.env,
) {
  const mode = env.MESSAGE_DELIVERY_RECEIPT_INBOX_MODE;
  if (!mode || mode === "OFF") return { retained: false };
  if (mode !== "CAPTURE") throw Error("DELIVERY_RECEIPT_CAPTURE_MODE_INVALID");
  if (!outcome.providerMessageId.trim() || !Number.isFinite(outcome.eventAt.getTime()) ||
      (outcome.deliveredAt && !Number.isFinite(outcome.deliveredAt.getTime()))) {
    throw Error("DELIVERY_RECEIPT_CAPTURE_EVIDENCE_INVALID");
  }
  let accountKey: string;
  let eventKey: string;
  if (outcome.provider === "twilio") {
    const expected = env.TWILIO_ACCOUNT_SID?.trim();
    if (!expected || !/^AC[a-f0-9]{32}$/i.test(expected) || context.accountSid !== expected) {
      throw Error("DELIVERY_RECEIPT_TWILIO_ACCOUNT_MISMATCH");
    }
    accountKey = expected;
    // Twilio has no event ID; repeated status callbacks for the same SID are
    // semantically identical. Do not use receipt time in the deduplication key.
    eventKey = hash([outcome.providerMessageId, outcome.status, outcome.errorCode ?? null]);
  } else if (outcome.provider === "resend") {
    const configured = env.MESSAGE_DELIVERY_RESEND_ACCOUNT_KEY?.trim();
    if (!configured || !/^[a-zA-Z0-9_-]{1,100}$/.test(configured) || !context.eventId?.trim()) {
      throw Error("DELIVERY_RECEIPT_RESEND_ACCOUNT_OR_EVENT_MISSING");
    }
    // Server-owned namespace for the account authenticated by this endpoint's
    // webhook secret. Never accept an organization/account from the request body.
    accountKey = configured;
    eventKey = context.eventId.trim();
  } else throw Error("DELIVERY_RECEIPT_PROVIDER_INVALID");
  const id = hash([outcome.provider, accountKey, eventKey]);
  const fingerprint = hash([outcome.providerMessageId, outcome.status, outcome.errorCode ?? null,
    ...(outcome.provider === "resend" ? [outcome.eventAt.toISOString(), outcome.deliveredAt?.toISOString() ?? null] : [])]);
  let stored: { id: string; fingerprint: string } | null;
  try {
    stored = await db.messageDeliveryReceipt.upsert({
      where: { id }, update: {}, create: {
        id, provider: outcome.provider, accountKey, eventKey, fingerprint,
        providerMessageId: outcome.providerMessageId, deliveryStatus: outcome.status,
        eventAt: outcome.eventAt, deliveredAt: outcome.deliveredAt ?? null,
        providerErrorCode: outcome.errorCode ?? null,
      }, select: { id: true, fingerprint: true },
    });
  } catch (error) {
    // Prisma may emulate an upsert with an empty update; a concurrent insert
    // can win between read and create. Only a verified unique collision retries.
    if ((error as { code?: string })?.code !== "P2002") throw error;
    stored = await db.messageDeliveryReceipt.findUnique({ where: { id }, select: { id: true, fingerprint: true } });
    if (!stored) throw error;
  }
  if (stored.fingerprint !== fingerprint) throw Error("DELIVERY_RECEIPT_EVENT_CONFLICT");
  return { retained: true, receiptId: stored.id };
}
