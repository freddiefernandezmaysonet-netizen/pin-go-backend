import { Router, type Request, type RequestHandler } from "express";
import type { PrismaClient } from "@prisma/client";
import { requireAuth } from "../middleware/requireAuth.js";
import { createReviewRateLimit, reviewActorClientKey, reviewClientKey, requireTrustedReviewMutationOrigin } from "../services/reviews/review-route-security.js";
import { HostIncidentError, fail, type HostEnvironment } from "../pin-ai/host/host-incident-policy.js";
import { applyHostIncidentCommand, listHostIncidents, readHostIncident, readPublishedIncidentUpdates } from "../pin-ai/host/host-incident.service.js";

export function buildHostIncidentRouter(input: { prisma: PrismaClient; env: HostEnvironment }) {
  const router = Router(), root = "/api/dashboard/pin-ai/incidents";
  const enabled: RequestHandler = (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    if (input.env.PIN_AI_HOST_INCIDENT_ENABLED !== "true") { res.status(404).json({ ok: false, error: "NOT_FOUND" }); return; }
    next();
  };
  const limit = (namespace: string, max: number, key = reviewActorClientKey) => createReviewRateLimit({ namespace, max, key, windowMs: 60_000 });
  const actor = (req: Request) => {
    const a = (req as Request & { user?: { id: string; orgId: string } }).user;
    if (!a?.id || !a.orgId) return fail(401, "UNAUTHENTICATED");
    return a;
  };
  const wrap = (run: (req: Request) => Promise<unknown>): RequestHandler => async (req, res) => {
    try { res.json({ ok: true, ...await run(req) as object }); }
    catch (error) {
      res.status(error instanceof HostIncidentError ? error.status : 503).json({ ok: false,
        error: error instanceof HostIncidentError ? error.code : "HOST_INCIDENT_UNAVAILABLE" });
    }
  };
  const cursor = (value: unknown) => {
    if (value === undefined) return undefined;
    if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) return fail(400, "INVALID_REQUEST");
    return value;
  };
  router.use(root, enabled, requireAuth, limit("host-incident-read", 120));
  router.get(root, wrap(req => listHostIncidents({ ...input, actor: actor(req), before: cursor(req.query.before) })));
  router.get(`${root}/:reference`, wrap(req => {
    const after = req.query.after === undefined ? 0 : Number(req.query.after);
    if (Array.isArray(req.query.after) || !Number.isSafeInteger(after) || after < 0) return fail(400, "INVALID_REQUEST");
    return readHostIncident({ ...input, actor: actor(req), reference: req.params.reference, after });
  }));
  router.post(`${root}/:reference/actions`, requireTrustedReviewMutationOrigin, limit("host-incident-write", 30),
    wrap(req => applyHostIncidentCommand({ ...input, actor: actor(req), reference: req.params.reference, command: req.body })));
  router.get("/api/public-booking/manage/:guestToken/pin-ai/incident-updates", enabled,
    limit("host-incident-guest-read", 60, reviewClientKey), wrap(req => {
      if (!/^[A-Za-z0-9_-]{16,200}$/.test(req.params.guestToken)) return fail(400, "INVALID_REQUEST");
      return readPublishedIncidentUpdates({ ...input, guestToken: req.params.guestToken, after: cursor(req.query.after) });
    }));
  return router;
}
