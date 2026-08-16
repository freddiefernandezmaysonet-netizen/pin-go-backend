import {
  Router,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/requireAuth.js";
import {
  BrandManagementError,
  createBrandRevisionDraft,
  initializeEnterpriseBrand,
  publishEnterpriseBrand,
  registerBrandDomain,
  suspendEnterpriseBrand,
  transitionBrandDomain,
  type BrandIdentityInput,
  type ManagedBrandDomainType,
} from "../services/branding/brand-management.service.js";
import {
  BrandReviewServiceError,
  submitBrandRevisionForApproval,
} from "../services/branding/brand-review.service.js";
import {
  EnterpriseBrandOnboardingError,
  provisionEnterpriseBrandOrganization,
} from "../services/branding/enterprise-brand-onboarding.service.js";
import {
  createOrganizationOwnerInvitation,
  OrganizationInvitationError,
  revokeOrganizationOwnerInvitation,
} from "../services/branding/organization-invitation.service.js";
import {
  BrandPolicyError,
  type BrandDomainStatus,
} from "../services/branding/brand-policy.js";

type AuthenticatedPlatformAdmin = {
  userId: string;
};

type AuthenticatedRequest = Request & {
  user?: {
    id?: string;
    role?: string;
  };
};

class AdminBrandingRouteInputError extends Error {
  constructor(
    readonly field: string,
    message: string
  ) {
    super(message);
    this.name = "AdminBrandingRouteInputError";
  }
}

const DOMAIN_TYPES = new Set<ManagedBrandDomainType>([
  "PINNGO_SUBDOMAIN",
  "CUSTOM_DOMAIN",
]);

const DOMAIN_STATUSES = new Set<BrandDomainStatus>([
  "PENDING_CONFIGURATION",
  "PENDING_DNS",
  "VERIFYING",
  "ACTIVE",
  "FAILED",
  "RETIRED",
]);

export const adminBrandingRouter = Router();

adminBrandingRouter.use((_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});

function authenticatedPlatformAdmin(
  req: Request,
  res: Response
): AuthenticatedPlatformAdmin | null {
  const user = (req as AuthenticatedRequest).user;
  const userId = String(user?.id ?? "").trim();

  if (!userId || user?.role !== "PLATFORM_ADMIN") {
    res.status(403).json({
      ok: false,
      error: "PLATFORM_ADMIN_REQUIRED",
    });
    return null;
  }

  return { userId };
}

function routeParameter(req: Request, name: string): string {
  const value = String(req.params[name] ?? "").trim();
  if (!value) {
    throw new AdminBrandingRouteInputError(
      name,
      `${name} is required.`
    );
  }
  return value;
}

function bodyString(req: Request, field: string): string {
  const value = req.body?.[field];
  if (typeof value !== "string") {
    throw new AdminBrandingRouteInputError(
      field,
      `${field} must be a string.`
    );
  }
  return value;
}

function optionalNullableBodyString(
  req: Request,
  field: string
): string | null | undefined {
  const value = req.body?.[field];
  if (value === undefined || value === null) return value;
  if (typeof value !== "string") {
    throw new AdminBrandingRouteInputError(
      field,
      `${field} must be a string or null.`
    );
  }
  const normalized = value.trim();
  return normalized || null;
}

function optionalNullableBodyDate(
  req: Request,
  field: string
): Date | null | undefined {
  const value = req.body?.[field];
  if (value === undefined || value === null) return value;
  if (typeof value !== "string") {
    throw new AdminBrandingRouteInputError(
      field,
      `${field} must be an ISO date string or null.`
    );
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new AdminBrandingRouteInputError(
      field,
      `${field} must be a valid ISO date string.`
    );
  }
  return parsed;
}

function brandIdentity(req: Request): BrandIdentityInput {
  return {
    displayName: bodyString(req, "displayName"),
    logoUrl: bodyString(req, "logoUrl"),
    logoPublicId: bodyString(req, "logoPublicId"),
    faviconUrl: bodyString(req, "faviconUrl"),
    faviconPublicId: bodyString(req, "faviconPublicId"),
    primaryColor: bodyString(req, "primaryColor"),
  };
}

function domainType(req: Request): ManagedBrandDomainType {
  const value = bodyString(req, "domainType").trim().toUpperCase();
  if (!DOMAIN_TYPES.has(value as ManagedBrandDomainType)) {
    throw new AdminBrandingRouteInputError(
      "domainType",
      "domainType must be PINNGO_SUBDOMAIN or CUSTOM_DOMAIN."
    );
  }
  return value as ManagedBrandDomainType;
}

function domainStatus(req: Request): BrandDomainStatus {
  const value = bodyString(req, "toStatus").trim().toUpperCase();
  if (!DOMAIN_STATUSES.has(value as BrandDomainStatus)) {
    throw new AdminBrandingRouteInputError(
      "toStatus",
      "toStatus is not a valid brand domain status."
    );
  }
  return value as BrandDomainStatus;
}

function errorStatus(error: unknown): number {
  if (error instanceof AdminBrandingRouteInputError) return 400;

  if (error instanceof BrandPolicyError) {
    if (
      error.code === "BRAND_MANAGER_REQUIRED" ||
      error.code === "BRAND_REVIEWER_REQUIRED" ||
      error.code === "BRAND_REVIEW_ORGANIZATION_MISMATCH"
    ) {
      return 403;
    }
    return 409;
  }

  const code =
    error instanceof BrandManagementError ||
    error instanceof BrandReviewServiceError ||
    error instanceof EnterpriseBrandOnboardingError ||
    error instanceof OrganizationInvitationError
      ? error.code
      : "";

  if (
    code.includes("ACTOR_NOT_FOUND") ||
    code.includes("ACTOR_INACTIVE")
  ) {
    return 403;
  }
  if (
    code.includes("NOT_FOUND") ||
    code === "BRAND_MANAGEMENT_DOMAIN_NOT_FOUND" ||
    code === "BRAND_MANAGEMENT_REVISION_NOT_FOUND"
  ) {
    return 404;
  }
  if (
    code.includes("ALREADY") ||
    code.includes("CONFLICT") ||
    code.includes("REGISTERED") ||
    code.includes("REVOKED") ||
    code.includes("EXPIRED") ||
    code.includes("MISMATCH")
  ) {
    return 409;
  }
  if (code) return 400;

  return 500;
}

function errorCode(error: unknown): string {
  if (error instanceof AdminBrandingRouteInputError) {
    return "ADMIN_BRANDING_INPUT_INVALID";
  }
  if (
    error instanceof BrandPolicyError ||
    error instanceof BrandManagementError ||
    error instanceof BrandReviewServiceError ||
    error instanceof EnterpriseBrandOnboardingError ||
    error instanceof OrganizationInvitationError
  ) {
    return error.code;
  }
  return "ADMIN_BRANDING_INTERNAL_ERROR";
}

function sendRouteError(res: Response, error: unknown): void {
  const status = errorStatus(error);
  const code = errorCode(error);
  const response: Record<string, unknown> = {
    ok: false,
    error: code,
  };

  if (error instanceof AdminBrandingRouteInputError) {
    response.field = error.field;
    response.message = error.message;
  } else if (
    error instanceof BrandPolicyError ||
    error instanceof BrandManagementError ||
    error instanceof BrandReviewServiceError ||
    error instanceof EnterpriseBrandOnboardingError ||
    error instanceof OrganizationInvitationError
  ) {
    response.message = error.message;
    response.context = error.context;
  }

  if (status === 500) {
    console.error("[ADMIN_BRANDING_ROUTE_ERROR]", {
      name: error instanceof Error ? error.name : "UnknownError",
      code,
    });
  }
  res.status(status).json(response);
}

type PlatformAdminAction = (
  req: Request,
  res: Response,
  actor: AuthenticatedPlatformAdmin
) => Promise<void>;

function platformAdminAction(
  action: PlatformAdminAction
): RequestHandler {
  return async (req, res) => {
    const actor = authenticatedPlatformAdmin(req, res);
    if (!actor) return;

    try {
      await action(req, res, actor);
    } catch (error) {
      sendRouteError(res, error);
    }
  };
}

adminBrandingRouter.get(
  "/api/internal/admin/branding/organizations/:organizationId/status",
  requireAuth,
  platformAdminAction(async (req, res, actor) => {
    const manager = await prisma.dashboardUser.findUnique({
      where: { id: actor.userId },
      select: { role: true, isActive: true },
    });

    if (!manager?.isActive || manager.role !== "PLATFORM_ADMIN") {
      res.status(403).json({
        ok: false,
        error: "PLATFORM_ADMIN_REQUIRED",
      });
      return;
    }

    const organization = await prisma.organization.findUnique({
      where: { id: routeParameter(req, "organizationId") },
      select: {
        id: true,
        name: true,
        slug: true,
        createdAt: true,
        brandProfile: {
          select: {
            id: true,
            organizationId: true,
            experienceType: true,
            status: true,
            activeRevisionId: true,
            activeDomainId: true,
            createdAt: true,
            updatedAt: true,
            revisions: {
              orderBy: { version: "desc" },
              take: 20,
              select: {
                id: true,
                version: true,
                displayName: true,
                logoUrl: true,
                faviconUrl: true,
                primaryColor: true,
                approvalStatus: true,
                approvedAt: true,
                rejectedAt: true,
                rejectionReason: true,
                createdAt: true,
                updatedAt: true,
              },
            },
            domains: {
              orderBy: { createdAt: "desc" },
              take: 20,
              select: {
                id: true,
                hostname: true,
                type: true,
                status: true,
                provider: true,
                providerDomainId: true,
                verifiedAt: true,
                activatedAt: true,
                retiredAt: true,
                redirectUntil: true,
                createdAt: true,
                updatedAt: true,
              },
            },
          },
        },
        organizationInvitations: {
          orderBy: { createdAt: "desc" },
          take: 20,
          select: {
            id: true,
            email: true,
            role: true,
            expiresAt: true,
            acceptedAt: true,
            revokedAt: true,
            createdAt: true,
          },
        },
      },
    });

    if (!organization) {
      res.status(404).json({
        ok: false,
        error: "ADMIN_BRANDING_ORGANIZATION_NOT_FOUND",
      });
      return;
    }

    res.json({ ok: true, data: { organization } });
  })
);

adminBrandingRouter.post(
  "/api/internal/admin/branding/enterprise-onboarding",
  requireAuth,
  platformAdminAction(async (req, res, actor) => {
    const result = await provisionEnterpriseBrandOrganization({
      actor,
      organizationName: bodyString(req, "organizationName"),
      organizationSlug: bodyString(req, "organizationSlug"),
      ownerEmail: bodyString(req, "ownerEmail"),
      identity: brandIdentity(req),
      hostname: bodyString(req, "hostname"),
      domainType: domainType(req),
    });

    res.status(201).json({ ok: true, data: result });
  })
);

adminBrandingRouter.post(
  "/api/internal/admin/branding/organizations/:organizationId/initialize",
  requireAuth,
  platformAdminAction(async (req, res, actor) => {
    const result = await initializeEnterpriseBrand({
      actor,
      organizationId: routeParameter(req, "organizationId"),
      identity: brandIdentity(req),
      hostname: bodyString(req, "hostname"),
      domainType: domainType(req),
    });

    res.status(201).json({ ok: true, data: result });
  })
);

adminBrandingRouter.post(
  "/api/internal/admin/branding/profiles/:brandProfileId/revisions",
  requireAuth,
  platformAdminAction(async (req, res, actor) => {
    const revision = await createBrandRevisionDraft({
      actor,
      brandProfileId: routeParameter(req, "brandProfileId"),
      identity: brandIdentity(req),
    });

    res.status(201).json({ ok: true, data: { revision } });
  })
);

adminBrandingRouter.post(
  "/api/internal/admin/branding/profiles/:brandProfileId/revisions/:brandRevisionId/submit",
  requireAuth,
  platformAdminAction(async (req, res, actor) => {
    const revision = await submitBrandRevisionForApproval({
      actor,
      brandProfileId: routeParameter(req, "brandProfileId"),
      brandRevisionId: routeParameter(req, "brandRevisionId"),
    });

    res.json({ ok: true, data: { revision } });
  })
);

adminBrandingRouter.post(
  "/api/internal/admin/branding/profiles/:brandProfileId/domains",
  requireAuth,
  platformAdminAction(async (req, res, actor) => {
    const domain = await registerBrandDomain({
      actor,
      brandProfileId: routeParameter(req, "brandProfileId"),
      hostname: bodyString(req, "hostname"),
      domainType: domainType(req),
    });

    res.status(201).json({ ok: true, data: { domain } });
  })
);

adminBrandingRouter.patch(
  "/api/internal/admin/branding/profiles/:brandProfileId/domains/:brandDomainId/status",
  requireAuth,
  platformAdminAction(async (req, res, actor) => {
    const providerDomainId = optionalNullableBodyString(
      req,
      "providerDomainId"
    );
    const redirectUntil = optionalNullableBodyDate(req, "redirectUntil");
    const domain = await transitionBrandDomain({
      actor,
      brandProfileId: routeParameter(req, "brandProfileId"),
      brandDomainId: routeParameter(req, "brandDomainId"),
      toStatus: domainStatus(req),
      ...(providerDomainId !== undefined ? { providerDomainId } : {}),
      ...(redirectUntil !== undefined ? { redirectUntil } : {}),
    });

    res.json({ ok: true, data: { domain } });
  })
);

adminBrandingRouter.post(
  "/api/internal/admin/branding/profiles/:brandProfileId/publish",
  requireAuth,
  platformAdminAction(async (req, res, actor) => {
    const publication = await publishEnterpriseBrand({
      actor,
      brandProfileId: routeParameter(req, "brandProfileId"),
      brandRevisionId: bodyString(req, "brandRevisionId"),
      brandDomainId: bodyString(req, "brandDomainId"),
    });

    res.json({ ok: true, data: publication });
  })
);

adminBrandingRouter.post(
  "/api/internal/admin/branding/profiles/:brandProfileId/suspend",
  requireAuth,
  platformAdminAction(async (req, res, actor) => {
    const profile = await suspendEnterpriseBrand({
      actor,
      brandProfileId: routeParameter(req, "brandProfileId"),
    });

    res.json({ ok: true, data: { profile } });
  })
);

adminBrandingRouter.post(
  "/api/internal/admin/branding/organizations/:organizationId/owner-invitations",
  requireAuth,
  platformAdminAction(async (req, res, actor) => {
    const invitation = await createOrganizationOwnerInvitation({
      actor,
      organizationId: routeParameter(req, "organizationId"),
      email: bodyString(req, "email"),
    });

    res.status(201).json({ ok: true, data: invitation });
  })
);

adminBrandingRouter.post(
  "/api/internal/admin/branding/owner-invitations/:invitationId/revoke",
  requireAuth,
  platformAdminAction(async (req, res, actor) => {
    const invitation = await revokeOrganizationOwnerInvitation({
      actor,
      invitationId: routeParameter(req, "invitationId"),
    });

    res.json({ ok: true, data: { invitation } });
  })
);
