import { Router, type Request, type Response } from "express";
import { requireAuth, type AuthenticatedUser } from "../middleware/requireAuth.js";
import { InboxError, type Page } from "../channex-messaging/host-inbox.js";
import type { buildHostInboxRuntime } from "../channex-messaging/host-inbox.runtime.js";
import { authorizeMobileReply } from "../channex-messaging/mobile-reply-authorization.js";
import { verifySessionBoundAuthToken } from "../auth/session-bound-token.js";
import { guardAuthenticatedSession } from "../auth/session-request-guard.js";
import { prisma } from "../lib/prisma.js";
import { readMobileReplyReceipt } from "../channex-messaging/mobile-reply-receipt.js";

type Runtime = NonNullable<ReturnType<typeof buildHostInboxRuntime>>;
type HostRequest = Request & { user?: AuthenticatedUser };
const HOST_ROLES = new Set(["ORG_ADMIN", "ADMIN", "PLATFORM_ADMIN"]);
function page(req: Request): Page {
  const parse = (value: unknown, fallback: number) => {
    if (value === undefined) return fallback;
    if (typeof value !== "string" || !/^[1-9]\d{0,4}$/.test(value)) throw new InboxError("HOST_INBOX_PAGE_INVALID", 400);
    return Number(value);
  };
  return { page: parse(req.query.page, 1), limit: parse(req.query.limit, 25) };
}
function failure(res: Response, error: unknown) {
  const known = error instanceof InboxError;
  return res.status(known ? error.status : 503).json({ ok: false, error: known ? error.code : "HOST_INBOX_UNAVAILABLE" });
}
async function nativeAuthorization(req: HostRequest) {
  await authorizeMobileReply({ enabled: process.env.HOST_MOBILE_REPLY_ENABLED === "true",
    authorization: req.get("authorization"), origin: req.get("origin"), cookie: req.get("cookie"), identity: req.user }, {
    verify: verifySessionBoundAuthToken,
    guard: input => guardAuthenticatedSession(prisma as any, input),
  }).catch(error => {
    throw new InboxError(typeof error?.code === "string" ? error.code : "SESSION_VALIDATION_UNAVAILABLE",
      typeof error?.status === "number" ? error.status : 503);
  });
}
export function buildDashboardChannexHostInboxRouter(args: {
  runtime: Runtime | null;
  isTrustedOrigin(origin: string, organizationId: string): Promise<boolean>;
}) {
  const router = Router(), prefix = "/api/dashboard/channex-messages";
  router.use(prefix, requireAuth, (req: HostRequest, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    if (!req.user?.id || !req.user.orgId || !HOST_ROLES.has(req.user.role ?? "")) return res.status(403).json({ ok: false, error: "HOST_INBOX_FORBIDDEN" });
    if (!args.runtime) return res.status(503).json({ ok: false, error: "HOST_INBOX_DISABLED" });
    next();
  });
  router.get(`${prefix}/properties`, async (req: HostRequest, res) => {
    try { return res.json({ ok: true, ...await args.runtime!.properties(req.user!.orgId) }); }
    catch (error) { return failure(res, error); }
  });
  const path = `${prefix}/properties/:propertyId/threads`;
  router.get(`${path}/:threadId/mobile-receipt`, async (req: HostRequest, res) => {
    try {
      await nativeAuthorization(req);
      const receipt = await readMobileReplyReceipt({ organizationId: req.user!.orgId, requestedBy: req.user!.id,
        propertyId: req.params.propertyId!, threadId: req.params.threadId!, requestKey: req.get("idempotency-key") ?? "" },
        scope => prisma.channexHostMessageSend.findFirst({ where: scope, select: { status: true, response: true } }));
      return res.json({ ok: true, ...receipt });
    } catch (error) { return failure(res, error); }
  });
  router.post(`${path}/:threadId/mobile-messages`, async (req: HostRequest, res) => {
    try {
      await nativeAuthorization(req);
      const body: unknown = req.body;
      if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(key => key !== "text") ||
        typeof (body as { text?: unknown }).text !== "string") throw new InboxError("HOST_INBOX_REPLY_INVALID", 400);
      return res.json({ ok: true, ...await args.runtime!.reply({ organizationId: req.user!.orgId, requestedBy: req.user!.id,
        propertyId: req.params.propertyId!, threadId: req.params.threadId!, text: (body as { text: string }).text, requestKey: req.get("idempotency-key") ?? "" }) });
    } catch (error) { return failure(res, error); }
  });
  router.post(`${path}/:threadId/pin-ai-control`, async (req: HostRequest, res) => {
    try {
      const raw = req.get("origin");
      let origin: string | null = null;
      try { const url = new URL(raw ?? ""); if (["https:", "http:"].includes(url.protocol)) origin = url.origin; } catch { /* deny */ }
      if (!origin || raw !== origin || !await args.isTrustedOrigin(origin, req.user!.orgId)) throw new InboxError("HOST_INBOX_ORIGIN_FORBIDDEN", 403);
      const body: unknown = req.body;
      if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(k => k !== "mode") ||
        !["AUTO", "HUMAN"].includes(String((body as { mode?: unknown }).mode))) throw new InboxError("PIN_AI_CONTROL_INVALID", 400);
      return res.json({ ok: true, ...await args.runtime!.automation.control({ organizationId: req.user!.orgId, propertyId: req.params.propertyId!, threadId: req.params.threadId! }, (body as { mode: "AUTO" | "HUMAN" }).mode) });
    } catch (error) { return failure(res, error); }
  });
  router.get(path, async (req: HostRequest, res) => {
    try { return res.json({ ok: true, ...await args.runtime!.list({ organizationId: req.user!.orgId, propertyId: req.params.propertyId! }, page(req)) }); }
    catch (error) { return failure(res, error); }
  });
  router.get(`${path}/:threadId/messages`, async (req: HostRequest, res) => {
    try { return res.json({ ok: true, ...await args.runtime!.messages({ organizationId: req.user!.orgId, propertyId: req.params.propertyId! }, req.params.threadId!, page(req)) }); }
    catch (error) { return failure(res, error); }
  });
  router.post(`${path}/:threadId/pin-ai-draft`, async (req: HostRequest, res) => {
    try {
      const raw = req.get("origin");
      let origin: string | null = null;
      try { const url = new URL(raw ?? ""); if (url.protocol === "https:" || url.protocol === "http:") origin = url.origin; } catch { /* deny */ }
      if (!origin || origin !== raw || !await args.isTrustedOrigin(origin, req.user!.orgId)) throw new InboxError("HOST_INBOX_ORIGIN_FORBIDDEN", 403);
      const body: unknown = req.body;
      if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(key => key !== "messageId") ||
        typeof (body as { messageId?: unknown }).messageId !== "string" || !/^[0-9a-f-]{36}$/i.test((body as { messageId: string }).messageId)) throw new InboxError("PIN_AI_DRAFT_INPUT_INVALID", 400);
      return res.json({ ok: true, ...await args.runtime!.draft({ organizationId: req.user!.orgId, propertyId: req.params.propertyId!,
        threadId: req.params.threadId!, messageId: (body as { messageId: string }).messageId }) });
    } catch (error) { return failure(res, error); }
  });
  router.post(`${path}/:threadId/messages`, async (req: HostRequest, res) => {
    try {
      const raw = req.get("origin");
      let origin: string | null = null;
      try { const url = new URL(raw ?? ""); if (url.protocol === "https:" || url.protocol === "http:") origin = url.origin; } catch { /* deny */ }
      if (!origin || origin !== raw || !await args.isTrustedOrigin(origin, req.user!.orgId)) throw new InboxError("HOST_INBOX_ORIGIN_FORBIDDEN", 403);
      const body: unknown = req.body;
      if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(key => key !== "text") ||
        typeof (body as { text?: unknown }).text !== "string") throw new InboxError("HOST_INBOX_REPLY_INVALID", 400);
      return res.json({ ok: true, ...await args.runtime!.reply({ organizationId: req.user!.orgId, requestedBy: req.user!.id,
        propertyId: req.params.propertyId!, threadId: req.params.threadId!, text: (body as { text: string }).text, requestKey: req.get("idempotency-key") ?? "" }) });
    } catch (error) { return failure(res, error); }
  });
  return router;
}
