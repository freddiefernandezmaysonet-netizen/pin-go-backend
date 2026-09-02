import { Router, type RequestHandler, type Response } from "express";
import { reviewsE1Enabled } from "../config/reviews.config.js";
import { prisma } from "../lib/prisma.js";
import { ReviewPolicyError } from "../services/reviews/review-policy.js";
import {
  createReviewRateLimit,
  reviewClientKey,
  reviewPropertyClientKey,
  reviewTokenClientKey,
  reviewTokenFromRequest,
} from "../services/reviews/review-route-security.js";
import { getPublicPropertyReviews, getReviewInvitation, submitReview } from "../services/reviews/review.service.js";

export const publicReviewsRouter = Router();

const invitationReadIpLimit = createReviewRateLimit({
  namespace: "public-review-invitation-read-ip",
  windowMs: 15 * 60_000,
  max: 90,
  key: reviewClientKey,
});
const invitationReadTokenLimit = createReviewRateLimit({
  namespace: "public-review-invitation-read-token-client",
  windowMs: 15 * 60_000,
  max: 30,
  key: reviewTokenClientKey,
});
const reviewSubmissionIpLimit = createReviewRateLimit({
  namespace: "public-review-submission-ip",
  windowMs: 15 * 60_000,
  max: 30,
  key: reviewClientKey,
});
const reviewSubmissionTokenLimit = createReviewRateLimit({
  namespace: "public-review-submission-token-client",
  windowMs: 15 * 60_000,
  max: 8,
  key: reviewTokenClientKey,
});
const publicReviewListingIpLimit = createReviewRateLimit({
  namespace: "public-review-listing-ip",
  windowMs: 60_000,
  max: 180,
  key: reviewClientKey,
});
const publicReviewListingPropertyLimit = createReviewRateLimit({
  namespace: "public-review-listing-property-client",
  windowMs: 60_000,
  max: 120,
  key: reviewPropertyClientKey,
});
const reviewTokenPrivacyHeaders: RequestHandler = (_req, res, next) => {
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
  next();
};

publicReviewsRouter.use("/api/public-reviews", (_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  if (!reviewsE1Enabled()) return res.status(404).json({ ok: false, error: "NOT_FOUND" });
  next();
});

function sendError(res: Response, error: unknown) {
  if (error instanceof ReviewPolicyError) return res.status(error.status).json({ ok: false, error: error.code, message: error.message });
  if (typeof error === "object" && error !== null && "code" in error && error.code === "P2002") return res.status(409).json({ ok: false, error: "REVIEW_ALREADY_SUBMITTED" });
  console.error("[PUBLIC_REVIEWS_ERROR]", { name: error instanceof Error ? error.name : "UnknownError" });
  return res.status(500).json({ ok: false, error: "REVIEW_INTERNAL_ERROR" });
}

publicReviewsRouter.get(
  "/api/public-reviews/invitation",
  reviewTokenPrivacyHeaders,
  invitationReadIpLimit,
  invitationReadTokenLimit,
  async (req, res) => {
    try {
      return res.json({
        ok: true,
        invitation: await getReviewInvitation(reviewTokenFromRequest(req)),
      });
    } catch (error) {
      return sendError(res, error);
    }
  }
);

publicReviewsRouter.post(
  "/api/public-reviews/submissions",
  reviewTokenPrivacyHeaders,
  reviewSubmissionIpLimit,
  reviewSubmissionTokenLimit,
  async (req, res) => {
    try {
      return res.status(201).json({
        ok: true,
        review: await submitReview(reviewTokenFromRequest(req), req.body),
      });
    } catch (error) {
      return sendError(res, error);
    }
  }
);

publicReviewsRouter.get(
  "/api/public-reviews/property/:organizationSlug/:propertySlug",
  publicReviewListingIpLimit,
  publicReviewListingPropertyLimit,
  async (req, res) => {
    try {
      const property = await prisma.property.findFirst({
        where: {
          slug: String(req.params.propertySlug),
          status: "ACTIVE", isPublicBookable: true,
          organization: {
            slug: String(req.params.organizationSlug),
            publicBookingEnabled: true,
          },
        },
        select: { id: true },
      });
      if (!property) {
        return res.status(404).json({
          ok: false,
          error: "PROPERTY_NOT_FOUND",
        });
      }
      const page = Number(req.query.page ?? 1);
      const pageSize = Number(req.query.pageSize ?? 10);
      const sort = req.query.sort;
      res.setHeader(
        "Cache-Control",
        "public, max-age=60, stale-while-revalidate=300"
      );
      return res.json({
        ok: true,
        ...(await getPublicPropertyReviews(property.id, page, pageSize, sort)),
      });
    } catch (error) {
      return sendError(res, error);
    }
  }
);
