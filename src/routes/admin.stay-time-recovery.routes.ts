import { Router, type Request, type RequestHandler } from "express";
import type { PrismaClient } from "@prisma/client";
import { requireAuth, type AuthenticatedUser } from "../middleware/requireAuth.js";
import { createReviewRateLimit, reviewActorClientKey, requireTrustedReviewMutationOrigin } from "../services/reviews/review-route-security.js";
import { listStayTimeOperatorReviews, readStayTimeOperatorReview, recordStayTimeOperatorReview,
  StayTimeOperatorReviewError } from "../services/stay-time-operator-review.service.js";

/** Mounted in the existing platform financial router; no provider composition. */
export function buildAdminStayTimeRecoveryRouter(db: PrismaClient) {
  const router = Router();
  const actor = (req: Request) => (req as Request & { user: AuthenticatedUser }).user;
  router.use((_req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); }, requireAuth,
    (req, res, next) => {
      if (actor(req)?.role !== "PLATFORM_ADMIN") return res.status(403).json({ ok: false, error: "PLATFORM_ADMIN_REQUIRED" });
      next();
    }, createReviewRateLimit({ namespace: "stay-time-operator-read", max: 120, windowMs: 60_000, key: reviewActorClientKey }));
  const wrap = (work: (req: Request) => Promise<unknown>): RequestHandler => async (req, res) => {
    try { res.json({ ok: true, ...await work(req) as object }); }
    catch (error) { res.status(error instanceof StayTimeOperatorReviewError ? error.status : 503)
      .json({ ok: false, error: error instanceof StayTimeOperatorReviewError ? error.code : "RECOVERY_REVIEW_UNAVAILABLE" }); }
  };
  router.get("/", wrap(req => listStayTimeOperatorReviews(db, actor(req), req.query)));
  router.get("/:issueId", wrap(req => readStayTimeOperatorReview(db, actor(req), req.params.issueId)));
  router.post("/:issueId/reviews", requireTrustedReviewMutationOrigin,
    createReviewRateLimit({ namespace: "stay-time-operator-write", max: 30, windowMs: 60_000, key: reviewActorClientKey }),
    wrap(req => recordStayTimeOperatorReview(db, actor(req), req.params.issueId, req.body)));
  return router;
}
