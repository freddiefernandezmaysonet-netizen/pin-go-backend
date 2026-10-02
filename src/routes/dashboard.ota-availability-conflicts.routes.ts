import { Router, type Request, type RequestHandler } from "express";
import type { PrismaClient } from "@prisma/client";
import { requireAuth, type AuthenticatedUser } from "../middleware/requireAuth";
import { createReviewRateLimit, reviewActorClientKey, requireTrustedReviewMutationOrigin } from "../services/reviews/review-route-security";
import { AvailabilityConflictReviewError, readAvailabilityConflictReview, resolveAvailabilityConflictReview } from "../services/ota-availability-conflict-review.service";

export function buildAvailabilityConflictReviewRouter(db: PrismaClient) {
  const router = Router();
  const readPath = "/api/dashboard/reservations/:reservationId/availability-conflicts";
  const resolvePath = "/api/dashboard/availability-conflicts/:issueId/resolve";
  const actor = (req: Request) => (req as Request & { user: AuthenticatedUser }).user;
  const wrap = (work: (req: Request) => Promise<unknown>): RequestHandler => async (req, res) => {
    try { res.json({ ok: true, ...await work(req) as object }); }
    catch (error) { res.status(error instanceof AvailabilityConflictReviewError ? error.status : 503)
      .json({ ok: false, error: error instanceof AvailabilityConflictReviewError ? error.code : "CONFLICT_REVIEW_UNAVAILABLE" }); }
  };
  const common: RequestHandler[] = [(_req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); }, requireAuth,
    createReviewRateLimit({ namespace: "ota-conflict-review", max: 120, windowMs: 60_000, key: reviewActorClientKey })];
  router.get(readPath, ...common, wrap(req => readAvailabilityConflictReview(db, actor(req), req.params.reservationId)));
  router.post(resolvePath, ...common, requireTrustedReviewMutationOrigin,
    createReviewRateLimit({ namespace: "ota-conflict-resolve", max: 30, windowMs: 60_000, key: reviewActorClientKey }),
    wrap(req => resolveAvailabilityConflictReview(db, actor(req), req.params.issueId, req.body)));
  return router;
}
