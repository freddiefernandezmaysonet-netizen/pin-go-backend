import {
  Router,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/requireAuth.js";
import {
  approveBrandRevision,
  BrandReviewServiceError,
  rejectBrandRevision,
} from "../services/branding/brand-review.service.js";
import { BrandPolicyError } from "../services/branding/brand-policy.js";

type OrganizationReviewer = {
  userId: string;
  organizationId: string;
};

type AuthenticatedRequest = Request & {
  user?: {
    id?: string;
    orgId?: string;
    role?: string;
  };
};

class OrganizationBrandingRouteInputError extends Error {
  constructor(
    readonly field: string,
    message: string
  ) {
    super(message);
    this.name = "OrganizationBrandingRouteInputError";
  }
}

export const organizationBrandingRouter = Router();

organizationBrandingRouter.use((_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});

function sessionReviewer(req: Request, res: Response) {
  const user = (req as AuthenticatedRequest).user;
  const userId = String(user?.id ?? "").trim();
  const organizationId = String(user?.orgId ?? "").trim();

  if (
    !userId ||
    !organizationId ||
    (user?.role !== "ADMIN" && user?.role !== "ORG_ADMIN")
  ) {
    res.status(403).json({
      ok: false,
      error: "BRAND_REVIEWER_REQUIRED",
    });
    return null;
  }

  return { userId, organizationId };
}

async function verifiedReviewer(
  req: Request,
  res: Response
): Promise<OrganizationReviewer | null> {
  const session = sessionReviewer(req, res);
  if (!session) return null;

  const user = await prisma.dashboardUser.findUnique({
    where: { id: session.userId },
    select: {
      id: true,
      organizationId: true,
      role: true,
      isActive: true,
    },
  });
  if (
    !user ||
    !user.isActive ||
    user.organizationId !== session.organizationId ||
    (user.role !== "ADMIN" && user.role !== "ORG_ADMIN")
  ) {
    res.status(403).json({
      ok: false,
      error: "BRAND_REVIEWER_REQUIRED",
    });
    return null;
  }

  return {
    userId: user.id,
    organizationId: user.organizationId,
  };
}

function routeParameter(req: Request, name: string): string {
  const value = String(req.params[name] ?? "").trim();
  if (!value) {
    throw new OrganizationBrandingRouteInputError(
      name,
      `${name} is required.`
    );
  }
  return value;
}

function bodyString(req: Request, field: string): string {
  const value = req.body?.[field];
  if (typeof value !== "string") {
    throw new OrganizationBrandingRouteInputError(
      field,
      `${field} must be a string.`
    );
  }
  return value;
}

function sendOrganizationBrandingError(
  res: Response,
  error: unknown
): void {
  if (error instanceof OrganizationBrandingRouteInputError) {
    res.status(400).json({
      ok: false,
      error: "ORGANIZATION_BRANDING_INPUT_INVALID",
      field: error.field,
      message: error.message,
    });
    return;
  }

  if (error instanceof BrandPolicyError) {
    const status =
      error.code === "BRAND_REVIEWER_REQUIRED" ||
      error.code === "BRAND_REVIEW_ORGANIZATION_MISMATCH"
        ? 403
        : 409;
    res.status(status).json({
      ok: false,
      error: error.code,
      message: error.message,
    });
    return;
  }

  if (error instanceof BrandReviewServiceError) {
    const status = error.code.includes("ACTOR_")
      ? 403
      : error.code.includes("NOT_FOUND")
        ? 404
        : 409;
    res.status(status).json({
      ok: false,
      error: error.code,
      message: error.message,
    });
    return;
  }

  console.error("[ORGANIZATION_BRANDING_ROUTE_ERROR]", {
    name: error instanceof Error ? error.name : "UnknownError",
  });
  res.status(500).json({
    ok: false,
    error: "ORGANIZATION_BRANDING_INTERNAL_ERROR",
  });
}

type OrganizationReviewerAction = (
  req: Request,
  res: Response,
  reviewer: OrganizationReviewer
) => Promise<void>;

function organizationReviewerAction(
  action: OrganizationReviewerAction
): RequestHandler {
  return async (req, res) => {
    try {
      const reviewer = await verifiedReviewer(req, res);
      if (!reviewer) return;
      await action(req, res, reviewer);
    } catch (error) {
      sendOrganizationBrandingError(res, error);
    }
  };
}

organizationBrandingRouter.get(
  "/api/org/branding/review",
  requireAuth,
  organizationReviewerAction(async (_req, res, reviewer) => {
    const profile = await prisma.brandProfile.findUnique({
      where: { organizationId: reviewer.organizationId },
      select: {
        id: true,
        organizationId: true,
        experienceType: true,
        status: true,
        activeRevisionId: true,
        activeDomainId: true,
        activeRevision: {
          select: {
            id: true,
            version: true,
            displayName: true,
            logoUrl: true,
            faviconUrl: true,
            primaryColor: true,
            approvalStatus: true,
          },
        },
        activeDomain: {
          select: {
            id: true,
            hostname: true,
            status: true,
          },
        },
        revisions: {
          where: { approvalStatus: "PENDING_APPROVAL" },
          orderBy: { version: "desc" },
          select: {
            id: true,
            version: true,
            displayName: true,
            logoUrl: true,
            faviconUrl: true,
            primaryColor: true,
            approvalStatus: true,
            createdAt: true,
          },
        },
      },
    });

    const pendingRevisions = profile?.revisions ?? [];
    const profileSummary = profile
      ? {
          id: profile.id,
          organizationId: profile.organizationId,
          experienceType: profile.experienceType,
          status: profile.status,
          activeRevisionId: profile.activeRevisionId,
          activeDomainId: profile.activeDomainId,
          activeRevision: profile.activeRevision,
          activeDomain: profile.activeDomain,
        }
      : null;

    res.json({
      ok: true,
      data: {
        profile: profileSummary,
        pendingRevisions,
      },
    });
  })
);

organizationBrandingRouter.post(
  "/api/org/branding/profiles/:brandProfileId/revisions/:brandRevisionId/approve",
  requireAuth,
  organizationReviewerAction(async (req, res, reviewer) => {
    const revision = await approveBrandRevision({
      actor: { userId: reviewer.userId },
      brandProfileId: routeParameter(req, "brandProfileId"),
      brandRevisionId: routeParameter(req, "brandRevisionId"),
    });

    res.json({ ok: true, data: { revision } });
  })
);

organizationBrandingRouter.post(
  "/api/org/branding/profiles/:brandProfileId/revisions/:brandRevisionId/reject",
  requireAuth,
  organizationReviewerAction(async (req, res, reviewer) => {
    const revision = await rejectBrandRevision({
      actor: { userId: reviewer.userId },
      brandProfileId: routeParameter(req, "brandProfileId"),
      brandRevisionId: routeParameter(req, "brandRevisionId"),
      rejectionReason: bodyString(req, "rejectionReason"),
    });

    res.json({ ok: true, data: { revision } });
  })
);
