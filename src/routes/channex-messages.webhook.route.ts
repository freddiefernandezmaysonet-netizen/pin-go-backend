import { Router } from "express";
import { AI_WEBHOOK_HEADER, AI_WEBHOOK_PATH, validWebhookSecret } from "../channex-messaging/pin-ai-auto.policy.js";
import { InboxError } from "../channex-messaging/host-inbox.js";

export function buildChannexMessagesWebhookRouter(args: { enabled: boolean; secret: string | undefined; receive(body: unknown): Promise<{ ignored: boolean }> }) {
  const router = Router();
  router.post(AI_WEBHOOK_PATH, async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    if (!args.enabled) return res.status(503).json({ ok: false, error: "PIN_AI_AUTO_DISABLED" });
    if (!validWebhookSecret(args.secret, req.headers[AI_WEBHOOK_HEADER])) return res.status(401).json({ ok: false, error: "PIN_AI_WEBHOOK_AUTH_INVALID" });
    try { return res.status(202).json({ ok: true, ...await args.receive(req.body) }); }
    catch (error) { return res.status(error instanceof InboxError ? error.status : 503).json({ ok: false, error: error instanceof InboxError ? error.code : "PIN_AI_INGEST_UNAVAILABLE" }); }
  });
  return router;
}
