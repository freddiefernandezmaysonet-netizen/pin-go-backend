import { Router, type Request, type Response } from "express";
import { reviewsE1Enabled } from "../config/reviews.config.js";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { RESPONSE_MODERATION_ACTIONS, ReviewPolicyError, parseReviewStatus, type ResponseModerationActionValue } from "../services/reviews/review-policy.js";
import { buildReviewModerationEvidence } from "../services/reviews/review-moderation-evidence.service.js";
import {
  createReviewRateLimit,
  requireTrustedReviewMutationOrigin,
  reviewActorClientKey,
} from "../services/reviews/review-route-security.js";
import { disputeReview, listOrganizationReviews, listReviewModerationQueue, moderateReview, moderateReviewResponse, respondToReview } from "../services/reviews/review.service.js";

type Session = { id: string; orgId: string; role?: string };
const session = (req: Request) => (req as Request & { user?: Session }).user;
export const dashboardReviewsRouter = Router();

const dashboardReviewReadLimit = createReviewRateLimit({
  namespace: "dashboard-review-read-actor",
  windowMs: 60_000,
  max: 240,
  key: reviewActorClientKey,
});
const moderationQueueReadLimit = createReviewRateLimit({
  namespace: "dashboard-review-moderation-queue-actor",
  windowMs: 60_000,
  max: 120,
  key: reviewActorClientKey,
});
const reviewResponseMutationLimit = createReviewRateLimit({
  namespace: "dashboard-review-response-actor",
  windowMs: 5 * 60_000,
  max: 30,
  key: reviewActorClientKey,
});
const reviewDisputeMutationLimit = createReviewRateLimit({
  namespace: "dashboard-review-dispute-actor",
  windowMs: 15 * 60_000,
  max: 12,
  key: reviewActorClientKey,
});
const reviewModerationMutationLimit = createReviewRateLimit({
  namespace: "dashboard-review-moderation-actor",
  windowMs: 5 * 60_000,
  max: 120,
  key: reviewActorClientKey,
});
const reviewResponseModerationMutationLimit = createReviewRateLimit({
  namespace: "dashboard-review-response-moderation-actor",
  windowMs: 5 * 60_000,
  max: 60,
  key: reviewActorClientKey,
});

dashboardReviewsRouter.use("/api/dashboard/reviews", requireAuth, (_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  if (!reviewsE1Enabled()) return res.status(404).json({ ok: false, error: "NOT_FOUND" });
  next();
});

dashboardReviewsRouter.use("/api/internal/reviews/moderation", requireAuth, (_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  if (!reviewsE1Enabled()) return res.status(404).json({ ok: false, error: "NOT_FOUND" });
  next();
});

async function verifiedPlatformModerator(req: Request, res: Response) {
  const actor = session(req);
  if (!actor || actor.role !== "PLATFORM_ADMIN") { res.status(403).json({ ok: false, error: "PLATFORM_REVIEW_MODERATOR_REQUIRED" }); return null; }
  const user = await prisma.dashboardUser.findFirst({ where: { id: actor.id, role: "PLATFORM_ADMIN", isActive: true }, select: { id: true } });
  if (!user) { res.status(403).json({ ok: false, error: "PLATFORM_REVIEW_MODERATOR_REQUIRED" }); return null; }
  return user;
}

async function verifiedOrganizationActor(req: Request, res: Response) {
  const actor = session(req);
  if (!actor?.id || !actor.orgId) { res.status(403).json({ ok: false, error: "REVIEW_ACTOR_REQUIRED" }); return null; }
  const user = await prisma.dashboardUser.findFirst({ where: { id: actor.id, organizationId: actor.orgId, role: { in: ["ADMIN", "ORG_ADMIN", "PLATFORM_ADMIN"] }, isActive: true }, select: { id: true, organizationId: true } });
  if (!user) { res.status(403).json({ ok: false, error: "REVIEW_ACTOR_REQUIRED" }); return null; }
  return user;
}

dashboardReviewsRouter.get("/api/internal/reviews/moderation", moderationQueueReadLimit, async (req, res) => {
  try {
    if (!await verifiedPlatformModerator(req, res)) return;
    return res.json({ ok: true, ...(await listReviewModerationQueue(req.query.page, req.query.pageSize)) });
  } catch (error) { return sendError(res, error); }
});

dashboardReviewsRouter.get("/api/internal/reviews/moderation/:id/evidence", moderationQueueReadLimit, async (req, res) => {
  try {
    if (!await verifiedPlatformModerator(req, res)) return;
    return res.json({
      ok: true,
      evidence: await buildReviewModerationEvidence(String(req.params.id)),
    });
  } catch (error) { return sendError(res, error); }
});

function sendError(res: Response, error: unknown) {
  if (error instanceof ReviewPolicyError) return res.status(error.status).json({ ok: false, error: error.code, message: error.message });
  if (typeof error === "object" && error !== null && "code" in error && error.code === "P2002") return res.status(409).json({ ok: false, error: "REVIEW_CONFLICT" });
  console.error("[DASHBOARD_REVIEWS_ERROR]", { name: error instanceof Error ? error.name : "UnknownError" });
  return res.status(500).json({ ok: false, error: "REVIEW_INTERNAL_ERROR" });
}

dashboardReviewsRouter.get("/api/dashboard/reviews", dashboardReviewReadLimit, async (req, res) => {
  try { const actor = await verifiedOrganizationActor(req, res); if (!actor) return; return res.json({ ok: true, ...(await listOrganizationReviews(actor.organizationId, parseReviewStatus(req.query.status), req.query.page, req.query.pageSize)) }); }
  catch (error) { return sendError(res, error); }
});

dashboardReviewsRouter.put(
  "/api/dashboard/reviews/:id/response",
  requireTrustedReviewMutationOrigin,
  reviewResponseMutationLimit,
  async (req, res) => {
    try {
      const actor = await verifiedOrganizationActor(req, res);
      if (!actor) return;
      return res.json({
        ok: true,
        response: await respondToReview(actor.organizationId, actor.id,
          String(req.params.id),
          req.body?.body
        ),
      });
    } catch (error) {
      return sendError(res, error);
    }
  }
);

dashboardReviewsRouter.post(
  "/api/dashboard/reviews/:id/response/moderate",
  requireTrustedReviewMutationOrigin,
  reviewResponseModerationMutationLimit,
  async (req, res) => {
    try {
      const actor = await verifiedPlatformModerator(req, res);
      if (!actor) return;
      const action = String(req.body?.action ?? "").toUpperCase();
      if (!(RESPONSE_MODERATION_ACTIONS as readonly string[]).includes(action)) {
        throw new ReviewPolicyError(
          "REVIEW_RESPONSE_MODERATION_ACTION_INVALID",
          "Invalid host-response moderation action.",
        );
      }
      return res.json({
        ok: true,
        response: await moderateReviewResponse(
          actor.id,
          String(req.params.id),
          action as ResponseModerationActionValue,
          req.body?.reasonCode,
          req.body?.note,
          req.body?.expectedRevision,
        ),
      });
    } catch (error) {
      return sendError(res, error);
    }
  },
);

dashboardReviewsRouter.post(
  "/api/dashboard/reviews/:id/disputes",
  requireTrustedReviewMutationOrigin,
  reviewDisputeMutationLimit,
  async (req, res) => {
    try {
      const actor = await verifiedOrganizationActor(req, res);
      if (!actor) return;
      return res.status(201).json({
        ok: true,
        moderationCase: await disputeReview(actor.organizationId, actor.id,
          String(req.params.id),
          req.body?.evidence,
          req.body?.note
        ),
      });
    } catch (error) {
      return sendError(res, error);
    }
  }
);

dashboardReviewsRouter.post(
  "/api/dashboard/reviews/:id/moderate",
  requireTrustedReviewMutationOrigin,
  reviewModerationMutationLimit,
  async (req, res) => {
    try {
      const actor = session(req)!;
      if (!await verifiedPlatformModerator(req, res)) return;
      const action = String(req.body?.action ?? "").toUpperCase();
      if (!["PUBLISH", "UPHOLD", "REJECT", "REMOVE", "HOLD"].includes(action)) {
        throw new ReviewPolicyError(
          "MODERATION_ACTION_INVALID",
          "Invalid moderation action."
        );
      }
      return res.json({
        ok: true,
        review: await moderateReview(
          actor.id,
          String(req.params.id),
          action as "PUBLISH" | "UPHOLD" | "REJECT" | "REMOVE" | "HOLD",
          req.body?.reasonCode,
          req.body?.note,
          req.body?.evidence, req.body?.expectedVersion
        ),
      });
    } catch (error) {
      return sendError(res, error);
    }
  }
);
