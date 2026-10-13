import { Router, text as rawText, type Request, type Response } from "express";
import type { PrismaClient, SalesVoiceCall } from "@prisma/client";

// ISOLATED, NOT MOUNTED. Signature verifier must be OpenAI SDK webhooks.unwrap.
// The OpenAI SIP call_id is NOT a Twilio CA... CallSid. SIP headers are identity hints only.
export class SalesSipIngressError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "SalesSipIngressError";
  }
}
const fail = (code: string): never => { throw new SalesSipIngressError(code); };

export type SignedSipInvite = {
  callId: string;
  webhookEventId: string;
  fromPhoneHint: string | null;
  toPhoneHint: string | null;
  sipCallIdHint: string | null;
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function phoneHint(raw: string | null): string | null {
  const match = raw?.match(/sips?:\s*(\+[1-9]\d{7,14})@/i);
  return match?.[1] ?? null;
}
/** Call only AFTER checking cryptographic signature and timestamp on the original body. */
export function parseVerifiedOpenAISipEvent(value: unknown): SignedSipInvite | null {
  if (!record(value)) return fail("INVALID_EVENT");
  if (value.type !== "realtime.call.incoming") return null;
  if (typeof value.id !== "string" || !/^evt_[a-zA-Z0-9_-]{8,120}$/.test(value.id)) return fail("INVALID_EVENT_ID");
  if (!record(value.data)) return fail("INVALID_DATA");
  const callId = value.data.call_id;
  if (typeof callId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(callId)) return fail("INVALID_CALL_ID");
  if (!Array.isArray(value.data.sip_headers) || value.data.sip_headers.length > 40) return fail("INVALID_HEADERS");
  const headers: { name: string; value: string }[] = [];
  for (const header of value.data.sip_headers) {
    if (!record(header) || typeof header.name !== "string" || typeof header.value !== "string"
      || header.name.length > 64 || header.value.length > 500) return fail("INVALID_HEADERS");
    headers.push({ name: header.name.toLowerCase(), value: header.value });
  }
  const read = (name: string) => headers.find(h => h.name === name)?.value.slice(0, 200) ?? null;
  return {
    callId,
    webhookEventId: value.id,
    fromPhoneHint: phoneHint(read("from")),
    toPhoneHint: phoneHint(read("to")),
    sipCallIdHint: read("call-id"),
  };
}

type Db = Pick<PrismaClient, "salesVoiceCall">;
/** Idempotent metadata only: no transfers, account matching, or call acceptance. */
export async function recordVerifiedSipInvite(db: Db, invite: SignedSipInvite): Promise<{
  call: SalesVoiceCall;
  duplicate: boolean;
}> {
  try {
    const call = await db.salesVoiceCall.create({
      data: {
        provider: "OPENAI_SIP",
        providerCallId: invite.callId,
        direction: "INBOUND",
        fromPhoneE164: invite.fromPhoneHint,
        toPhoneE164: invite.toPhoneHint,
        status: "RECEIVED",
      },
    });
    return { call, duplicate: false };
  } catch (error) {
    if (!record(error) || error.code !== "P2002") throw error;
    const call = await db.salesVoiceCall.findUnique({ where: { providerCallId: invite.callId } });
    if (!call) throw error;
    if (call.provider !== "OPENAI_SIP" || call.direction !== "INBOUND"
      || call.fromPhoneE164 !== invite.fromPhoneHint || call.toPhoneE164 !== invite.toPhoneHint) {
      return fail("CALL_ID_COLLISION");
    }
    return { call, duplicate: true };
  }
}

type WebhookHeaders = Record<string, string | undefined>;
export type VerifyOpenAIWebhook = (rawBody: string, headers: WebhookHeaders) => Promise<unknown>;
/**
 * NOT integrated with server.ts. The caller must provide a real OpenAI SDK
 * webhooks.unwrap verifier and mount this router BEFORE express.json().
 * This step records verified metadata only; a subsequent gated adapter will
 * perform realtime call admission, accept/reject, and lifecycle reconciliation.
 */
export function buildIsolatedSalesSipIngressRouter(deps: {
  enabled: () => boolean;
  verifySignedWebhook: VerifyOpenAIWebhook;
  persistVerifiedInvite: (invite: SignedSipInvite) => Promise<unknown>;
}): Router {
  if (!deps || typeof deps.enabled !== "function"
    || typeof deps.verifySignedWebhook !== "function"
    || typeof deps.persistVerifiedInvite !== "function") {
    return fail("MISSING_SECURE_DEPENDENCY");
  }
  const router = Router();
  router.post("/webhooks/openai/sales-voice", rawText({ type: "application/json", limit: "16kb" }),
    async (req: Request, res: Response) => {
      if (!deps.enabled()) return res.sendStatus(404);
      if (typeof req.body !== "string") return res.sendStatus(415);
      const headers: WebhookHeaders = {
        "webhook-id": req.header("webhook-id"),
        "webhook-timestamp": req.header("webhook-timestamp"),
        "webhook-signature": req.header("webhook-signature"),
      };
      if (!headers["webhook-id"] || !headers["webhook-timestamp"] || !headers["webhook-signature"]) {
        return res.sendStatus(401);
      }
      let verified: unknown;
      try {
        verified = await deps.verifySignedWebhook(req.body, headers);
      } catch {
        return res.sendStatus(401);
      }
      let invite: SignedSipInvite | null;
      try {
        invite = parseVerifiedOpenAISipEvent(verified);
      } catch {
        return res.sendStatus(400);
      }
      if (!invite) return res.sendStatus(204);
      try {
        await deps.persistVerifiedInvite(invite);
      } catch {
        return res.sendStatus(503);
      }
      // Explicitly NOT a live call receiver: this never calls /accept.
      return res.sendStatus(202);
    });
  return router;
}
