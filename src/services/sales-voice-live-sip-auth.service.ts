import { createHmac, timingSafeEqual } from "node:crypto";
import { Router, text as rawText, type Request, type Response } from "express";
import type { PrismaClient, SalesVoiceCall } from "@prisma/client";

/**
 * INTERNAL, UNMOUNTED foundation. The project must subscribe to
 * live.transport.incoming, with one Live owner of accept/reject. The Realtime
 * webhook must never initiate a second accept for the same SIP call.
 * No OpenAI API call, sideband session, Twilio action, or notification occurs.
 */
export class SalesLiveSipError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "SalesLiveSipError";
  }
}
const fail = (code: string): never => { throw new SalesLiveSipError(code); };

type WebhookHeaders = Record<string, string | undefined>;
const validBase64 = (value: string): boolean =>
  value.length >= 4 && value.length <= 1024 && value.length % 4 === 0
  && /^[A-Za-z0-9+/]+={0,2}$/.test(value);

function decodeBase64(value: string): Buffer {
  if (!validBase64(value)) return fail("INVALID_BASE64");
  const decoded = Buffer.from(value, "base64");
  if (!decoded.length || decoded.toString("base64") !== value) return fail("INVALID_BASE64");
  return decoded;
}

/**
 * Implements OpenAI's documented Standard Webhooks v1 signature:
 * HMAC-SHA256(secret, webhook-id + "." + webhook-timestamp + "." + rawBody).
 * The server MUST provide the original unmodified request body, not re-serialized
 * JSON. The secret must be configured server-side. Timestamp tolerance: 300 sec.
 * No dependence on application API keys or SDK installation.
 */
export function unwrapSignedOpenAIWebhook(
  rawBody: string,
  headers: WebhookHeaders,
  secret: string | undefined,
  nowMs: number = Date.now(),
): unknown {
  if (!secret || typeof secret !== "string") return fail("MISSING_SIGNING_SECRET");
  if (typeof rawBody !== "string" || Buffer.byteLength(rawBody, "utf8") > 16 * 1024) {
    return fail("INVALID_RAW_BODY");
  }
  const id = headers["webhook-id"];
  const timestamp = headers["webhook-timestamp"];
  const signature = headers["webhook-signature"];
  if (!id || !/^[A-Za-z0-9_-]{3,160}$/.test(id)
    || !timestamp || !/^[0-9]{10}$/.test(timestamp)
    || !signature || signature.length > 1024) return fail("INVALID_SIGNATURE_HEADERS");

  const seconds = Number(timestamp);
  const nowSeconds = Math.floor(nowMs / 1000);
  if (!Number.isSafeInteger(seconds) || !Number.isFinite(nowMs)
    || Math.abs(nowSeconds - seconds) > 300) return fail("EXPIRED_WEBHOOK_TIMESTAMP");

  let key: Buffer;
  try {
    key = secret.startsWith("whsec_") ? decodeBase64(secret.slice(6)) : Buffer.from(secret, "utf8");
  } catch {
    return fail("INVALID_SIGNING_SECRET");
  }
  if (key.length < 16) return fail("INVALID_SIGNING_SECRET");
  const expected = createHmac("sha256", key)
    .update(id + "." + timestamp + "." + rawBody, "utf8").digest();

  const candidates = signature.split(" ");
  if (candidates.length > 8) return fail("TOO_MANY_SIGNATURES");
  let matched = false;
  for (const candidate of candidates) {
    const value = candidate.startsWith("v1,") ? candidate.slice(3) : candidate;
    try {
      const received = decodeBase64(value);
      if (received.length === expected.length && timingSafeEqual(received, expected)) matched = true;
    } catch {
      // Invalid candidates must not be accepted, but valid rotated candidates can match.
    }
  }
  if (!matched) return fail("INVALID_WEBHOOK_SIGNATURE");

  try {
    return JSON.parse(rawBody) as unknown;
  } catch {
    return fail("INVALID_SIGNED_JSON");
  }
}

type ObjectMap = Record<string, unknown>;
const isRecord = (v: unknown): v is ObjectMap =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export type VerifiedLiveSipInvitation = {
  sessionId: string;
  webhookEventId: string;
  fromPhoneHint: string | null;
  toPhoneHint: string | null;
};

/** Only trust this parser's input after successful signature verification. */
export function parseVerifiedLiveSipInvitation(value: unknown): VerifiedLiveSipInvitation | null {
  if (!isRecord(value)) return fail("INVALID_EVENT");
  // Realtime may be delivered for the same pending SIP call. NEVER accept it here.
  if (value.type !== "live.transport.incoming" && value.type !== "live.call.incoming") return null;
  if (!isRecord(value.data)) return fail("INVALID_LIVE_DATA");
  if (value.type === "live.transport.incoming" && value.data.type !== "sip") return null;
  if (value.type === "live.call.incoming" && value.data.type !== undefined
    && value.data.type !== "sip") return null;

  if (typeof value.id !== "string" || !/^evt_[A-Za-z0-9_-]{8,120}$/.test(value.id)) {
    return fail("INVALID_EVENT_ID");
  }
  const sessionId = value.data.session_id;
  // Preserve the opaque session ID, including its prefix.
  if (typeof sessionId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) {
    return fail("INVALID_SESSION_ID");
  }
  const rawHeaders = value.data.sip_headers;
  if (!Array.isArray(rawHeaders) || rawHeaders.length > 40) return fail("INVALID_SIP_HEADERS");
  const headers: { name: string; value: string }[] = [];
  for (const h of rawHeaders) {
    if (!isRecord(h) || typeof h.name !== "string" || typeof h.value !== "string"
      || h.name.length > 64 || h.value.length > 500) return fail("INVALID_SIP_HEADERS");
    headers.push({ name: h.name.toLowerCase(), value: h.value });
  }
  const read = (name: string) => headers.find(h => h.name === name)?.value ?? "";
  const hint = (raw: string): string | null =>
    raw.match(/sips?:\s*(\+[1-9]\d{7,14})@/i)?.[1] ?? null;

  return {
    sessionId,
    webhookEventId: value.id,
    fromPhoneHint: hint(read("from")),
    toPhoneHint: hint(read("to")),
  };
}

type Db = Pick<PrismaClient, "salesVoiceCall">;

/**
 * Unique session IDs deduplicate webhook retries. These are NOT customer IDs;
 * phone numbers are untrusted SIP presentation data, not verified lead identity.
 */
export async function recordVerifiedLiveSipInvite(
  db: Db,
  invite: VerifiedLiveSipInvitation,
): Promise<{ call: SalesVoiceCall; duplicate: boolean }> {
  try {
    const call = await db.salesVoiceCall.create({
      data: {
        provider: "OPENAI_LIVE_SIP",
        providerCallId: invite.sessionId,
        direction: "INBOUND",
        fromPhoneE164: invite.fromPhoneHint,
        toPhoneE164: invite.toPhoneHint,
        status: "RECEIVED",
      },
    });
    return { call, duplicate: false };
  } catch (error) {
    if (!isRecord(error) || error.code !== "P2002") throw error;
    const call = await db.salesVoiceCall.findUnique({
      where: { providerCallId: invite.sessionId },
    });
    if (!call) throw error;
    if (call.provider !== "OPENAI_LIVE_SIP" || call.direction !== "INBOUND"
      || call.fromPhoneE164 !== invite.fromPhoneHint || call.toPhoneE164 !== invite.toPhoneHint) {
      return fail("SESSION_ID_COLLISION");
    }
    return { call, duplicate: true };
  }
}

/**
 * Isolated endpoint, NOT mounted in src/server.ts. Only verifies signatures and
 * persists metadata; it cannot accept, reject, connect, charge, or place calls.
 * Mount before application-wide JSON middleware if later authorized.
 */
export function buildIsolatedSalesLiveSipRouter(deps: {
  enabled: () => boolean;
  webhookSecret: () => string | undefined;
  persist: (invite: VerifiedLiveSipInvitation) => Promise<unknown>;
}): Router {
  if (!deps || typeof deps.enabled !== "function"
    || typeof deps.webhookSecret !== "function" || typeof deps.persist !== "function") {
    return fail("MISSING_SECURE_DEPENDENCY");
  }
  const router = Router();
  router.post("/webhooks/openai/sales-live-voice", rawText({
    type: "application/json", limit: "16kb",
  }), async (req: Request, res: Response) => {
    if (!deps.enabled()) return res.sendStatus(404);
    if (typeof req.body !== "string") return res.sendStatus(415);
    const headers: WebhookHeaders = {
      "webhook-id": req.header("webhook-id"),
      "webhook-timestamp": req.header("webhook-timestamp"),
      "webhook-signature": req.header("webhook-signature"),
    };
    let verified: unknown;
    try {
      verified = unwrapSignedOpenAIWebhook(req.body, headers, deps.webhookSecret());
    } catch {
      return res.sendStatus(401);
    }
    let invite: VerifiedLiveSipInvitation | null;
    try {
      invite = parseVerifiedLiveSipInvitation(verified);
    } catch {
      return res.sendStatus(400);
    }
    if (!invite) return res.sendStatus(204);
    try {
      await deps.persist(invite);
    } catch {
      return res.sendStatus(503);
    }
    // Acknowledge verified metadata only, NOT a live-call admission decision.
    return res.sendStatus(202);
  });
  return router;
}
