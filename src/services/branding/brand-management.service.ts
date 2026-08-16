import { prisma } from "../../lib/prisma.js";
import {
  deriveAccessibleBrandTextColor,
  requireBrandDomainTransition,
  requireBrandManagerRole,
  requireBrandProfileTransition,
  requireBrandPublicationReadiness,
  type BrandDomainStatus,
} from "./brand-policy.js";
import {
  isPinGoStandardHostname,
  normalizeBrandHostname,
} from "./published-brand-context.service.js";

export type BrandManagementErrorCode =
  | "BRAND_MANAGEMENT_INPUT_INVALID"
  | "BRAND_MANAGEMENT_ACTOR_NOT_FOUND"
  | "BRAND_MANAGEMENT_ACTOR_INACTIVE"
  | "BRAND_MANAGEMENT_ORGANIZATION_NOT_FOUND"
  | "BRAND_MANAGEMENT_PROFILE_ALREADY_EXISTS"
  | "BRAND_MANAGEMENT_PROFILE_NOT_FOUND"
  | "BRAND_MANAGEMENT_PROFILE_NOT_ENTERPRISE"
  | "BRAND_MANAGEMENT_REVISION_NOT_FOUND"
  | "BRAND_MANAGEMENT_DOMAIN_NOT_FOUND"
  | "BRAND_MANAGEMENT_DOMAIN_CONFLICT"
  | "BRAND_MANAGEMENT_DOMAIN_TYPE_INVALID"
  | "BRAND_MANAGEMENT_IDENTITY_INVALID";

export class BrandManagementError extends Error {
  constructor(
    readonly code: BrandManagementErrorCode,
    message: string,
    readonly context: Readonly<Record<string, unknown>> = {}
  ) {
    super(`${code}: ${message}`);
    this.name = "BrandManagementError";
  }
}

export type BrandManagerActorInput = {
  userId: string;
};

export type BrandIdentityInput = {
  displayName: string;
  logoUrl: string;
  logoPublicId: string;
  faviconUrl: string;
  faviconPublicId: string;
  primaryColor: string;
};

export type ManagedBrandDomainType =
  | "PINNGO_SUBDOMAIN"
  | "CUSTOM_DOMAIN";

export type InitializeEnterpriseBrandInput = {
  actor: BrandManagerActorInput;
  organizationId: string;
  identity: BrandIdentityInput;
  hostname: string;
  domainType: ManagedBrandDomainType;
};

export type CreateBrandRevisionDraftInput = {
  actor: BrandManagerActorInput;
  brandProfileId: string;
  identity: BrandIdentityInput;
};

export type RegisterBrandDomainInput = {
  actor: BrandManagerActorInput;
  brandProfileId: string;
  hostname: string;
  domainType: ManagedBrandDomainType;
};

export type TransitionBrandDomainInput = {
  actor: BrandManagerActorInput;
  brandProfileId: string;
  brandDomainId: string;
  toStatus: BrandDomainStatus;
  providerDomainId?: string | null;
  redirectUntil?: Date | null;
};

export type PublishEnterpriseBrandInput = {
  actor: BrandManagerActorInput;
  brandProfileId: string;
  brandRevisionId: string;
  brandDomainId: string;
};

export type SuspendEnterpriseBrandInput = {
  actor: BrandManagerActorInput;
  brandProfileId: string;
};

export type BrandManagementServiceOptions = {
  db?: typeof prisma;
  now?: () => Date;
};

type BrandManagementTransactionClient = Pick<
  typeof prisma,
  | "dashboardUser"
  | "organization"
  | "brandProfile"
  | "brandRevision"
  | "brandDomain"
>;

type NormalizedBrandIdentity = BrandIdentityInput;

function brandManagementTransactionClient(
  transaction: unknown
): BrandManagementTransactionClient {
  return transaction as BrandManagementTransactionClient;
}

function invalidInput(
  field: string,
  message: string,
  value?: unknown
): never {
  throw new BrandManagementError(
    "BRAND_MANAGEMENT_INPUT_INVALID",
    message,
    { field, value: value ?? null }
  );
}

function requiredId(value: string, field: string): string {
  const normalized = String(value ?? "").trim();
  if (!normalized) invalidInput(field, `${field} is required.`);
  return normalized;
}

function secureAssetUrl(value: string, field: string): string {
  const normalized = String(value ?? "").trim();

  try {
    const url = new URL(normalized);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      !url.hostname
    ) {
      throw new Error("unsafe URL");
    }
  } catch {
    throw new BrandManagementError(
      "BRAND_MANAGEMENT_IDENTITY_INVALID",
      `${field} must be a secure HTTPS URL without credentials.`,
      { field }
    );
  }

  return normalized;
}

function assetPublicId(value: string, field: string): string {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized.length > 255) {
    throw new BrandManagementError(
      "BRAND_MANAGEMENT_IDENTITY_INVALID",
      `${field} must contain between 1 and 255 characters.`,
      { field }
    );
  }
  return normalized;
}

function normalizeBrandIdentity(
  identity: BrandIdentityInput
): NormalizedBrandIdentity {
  const displayName = String(identity?.displayName ?? "").trim();
  if (displayName.length < 2 || displayName.length > 100) {
    throw new BrandManagementError(
      "BRAND_MANAGEMENT_IDENTITY_INVALID",
      "displayName must contain between 2 and 100 characters.",
      { field: "displayName" }
    );
  }

  const primaryColor = String(identity?.primaryColor ?? "")
    .trim()
    .toUpperCase();
  if (!/^#[0-9A-F]{6}$/.test(primaryColor)) {
    throw new BrandManagementError(
      "BRAND_MANAGEMENT_IDENTITY_INVALID",
      "primaryColor must use the #RRGGBB format.",
      { field: "primaryColor" }
    );
  }

  if (!deriveAccessibleBrandTextColor(primaryColor)) {
    throw new BrandManagementError(
      "BRAND_MANAGEMENT_IDENTITY_INVALID",
      "primaryColor must support accessible black or white text.",
      { field: "primaryColor" }
    );
  }

  return {
    displayName,
    logoUrl: secureAssetUrl(identity.logoUrl, "logoUrl"),
    logoPublicId: assetPublicId(identity.logoPublicId, "logoPublicId"),
    faviconUrl: secureAssetUrl(identity.faviconUrl, "faviconUrl"),
    faviconPublicId: assetPublicId(
      identity.faviconPublicId,
      "faviconPublicId"
    ),
    primaryColor,
  };
}

function normalizeManagedHostname(
  rawHostname: string,
  domainType: ManagedBrandDomainType
): string {
  const hostname = normalizeBrandHostname(rawHostname);
  if (!hostname || isPinGoStandardHostname(hostname)) {
    throw new BrandManagementError(
      "BRAND_MANAGEMENT_DOMAIN_CONFLICT",
      "The hostname is invalid or reserved by Pin&Go.",
      { hostname: rawHostname }
    );
  }

  const pinGoSuffix = ".pin-ngo.com";
  const isPinGoSubdomain = hostname.endsWith(pinGoSuffix);
  if (domainType === "PINNGO_SUBDOMAIN") {
    const prefix = hostname.slice(0, -pinGoSuffix.length);
    if (!isPinGoSubdomain || !prefix || prefix.includes(".")) {
      throw new BrandManagementError(
        "BRAND_MANAGEMENT_DOMAIN_TYPE_INVALID",
        "PINNGO_SUBDOMAIN must be one direct subdomain of pin-ngo.com.",
        { hostname }
      );
    }
  } else if (isPinGoSubdomain) {
    throw new BrandManagementError(
      "BRAND_MANAGEMENT_DOMAIN_TYPE_INVALID",
      "A pin-ngo.com hostname must use PINNGO_SUBDOMAIN.",
      { hostname }
    );
  }

  return hostname;
}

async function requireActivePlatformAdmin(
  tx: BrandManagementTransactionClient,
  rawUserId: string
): Promise<string> {
  const userId = requiredId(rawUserId, "actor.userId");
  const actor = await tx.dashboardUser.findUnique({
    where: { id: userId },
    select: {
      id: true,
      role: true,
      isActive: true,
    },
  });

  if (!actor) {
    throw new BrandManagementError(
      "BRAND_MANAGEMENT_ACTOR_NOT_FOUND",
      "The brand manager account does not exist.",
      { userId }
    );
  }
  if (!actor.isActive) {
    throw new BrandManagementError(
      "BRAND_MANAGEMENT_ACTOR_INACTIVE",
      "The brand manager account is inactive.",
      { userId }
    );
  }

  requireBrandManagerRole(actor.role);
  return actor.id;
}

async function requireEnterpriseProfile(
  tx: BrandManagementTransactionClient,
  rawProfileId: string
) {
  const profileId = requiredId(rawProfileId, "brandProfileId");
  const profile = await tx.brandProfile.findUnique({
    where: { id: profileId },
    select: {
      id: true,
      organizationId: true,
      experienceType: true,
      status: true,
      activeRevisionId: true,
      activeDomainId: true,
    },
  });

  if (!profile) {
    throw new BrandManagementError(
      "BRAND_MANAGEMENT_PROFILE_NOT_FOUND",
      "The brand profile does not exist.",
      { profileId }
    );
  }
  if (profile.experienceType !== "ENTERPRISE_BRANDED") {
    throw new BrandManagementError(
      "BRAND_MANAGEMENT_PROFILE_NOT_ENTERPRISE",
      "The profile is not configured for enterprise branding.",
      { profileId }
    );
  }

  return profile;
}

export async function initializeEnterpriseBrand(
  input: InitializeEnterpriseBrandInput,
  options: BrandManagementServiceOptions = {}
) {
  const db = options.db ?? prisma;
  const organizationId = requiredId(input.organizationId, "organizationId");
  const identity = normalizeBrandIdentity(input.identity);
  const hostname = normalizeManagedHostname(
    input.hostname,
    input.domainType
  );

  return db.$transaction(
    async (transaction) => {
      const tx = brandManagementTransactionClient(transaction);
      const actorUserId = await requireActivePlatformAdmin(
        tx,
        input.actor.userId
      );
      const organization = await tx.organization.findUnique({
        where: { id: organizationId },
        select: { id: true },
      });
      if (!organization) {
        throw new BrandManagementError(
          "BRAND_MANAGEMENT_ORGANIZATION_NOT_FOUND",
          "The organization does not exist.",
          { organizationId }
        );
      }

      const existingProfile = await tx.brandProfile.findUnique({
        where: { organizationId },
        select: { id: true },
      });
      if (existingProfile) {
        throw new BrandManagementError(
          "BRAND_MANAGEMENT_PROFILE_ALREADY_EXISTS",
          "The organization already has a brand profile.",
          { organizationId, brandProfileId: existingProfile.id }
        );
      }

      const existingDomain = await tx.brandDomain.findUnique({
        where: { hostname },
        select: { id: true, brandProfileId: true },
      });
      if (existingDomain) {
        throw new BrandManagementError(
          "BRAND_MANAGEMENT_DOMAIN_CONFLICT",
          "The hostname is already assigned to another brand record.",
          { hostname }
        );
      }

      // This manual PLATFORM_ADMIN action represents commercial approval.
      // V1 intentionally does not infer eligibility from the property count.
      const profile = await tx.brandProfile.create({
        data: {
          organizationId,
          experienceType: "ENTERPRISE_BRANDED",
          status: "DRAFT",
        },
      });
      const revision = await tx.brandRevision.create({
        data: {
          brandProfileId: profile.id,
          version: 1,
          ...identity,
          approvalStatus: "DRAFT",
          createdByUserId: actorUserId,
        },
      });
      const domain = await tx.brandDomain.create({
        data: {
          brandProfileId: profile.id,
          hostname,
          type: input.domainType,
          status: "PENDING_CONFIGURATION",
          provider: "VERCEL",
          createdByUserId: actorUserId,
        },
      });

      return { profile, revision, domain };
    },
    { isolationLevel: "Serializable" }
  );
}

export async function createBrandRevisionDraft(
  input: CreateBrandRevisionDraftInput,
  options: BrandManagementServiceOptions = {}
) {
  const db = options.db ?? prisma;
  const identity = normalizeBrandIdentity(input.identity);

  return db.$transaction(
    async (transaction) => {
      const tx = brandManagementTransactionClient(transaction);
      const actorUserId = await requireActivePlatformAdmin(
        tx,
        input.actor.userId
      );
      const profile = await requireEnterpriseProfile(
        tx,
        input.brandProfileId
      );
      const latestRevision = await tx.brandRevision.findFirst({
        where: { brandProfileId: profile.id },
        orderBy: { version: "desc" },
        select: { version: true },
      });

      return tx.brandRevision.create({
        data: {
          brandProfileId: profile.id,
          version: (latestRevision?.version ?? 0) + 1,
          ...identity,
          approvalStatus: "DRAFT",
          createdByUserId: actorUserId,
        },
      });
    },
    { isolationLevel: "Serializable" }
  );
}

export async function registerBrandDomain(
  input: RegisterBrandDomainInput,
  options: BrandManagementServiceOptions = {}
) {
  const db = options.db ?? prisma;
  const hostname = normalizeManagedHostname(
    input.hostname,
    input.domainType
  );

  return db.$transaction(
    async (transaction) => {
      const tx = brandManagementTransactionClient(transaction);
      const actorUserId = await requireActivePlatformAdmin(
        tx,
        input.actor.userId
      );
      const profile = await requireEnterpriseProfile(
        tx,
        input.brandProfileId
      );
      const existingDomain = await tx.brandDomain.findUnique({
        where: { hostname },
        select: { id: true },
      });
      if (existingDomain) {
        throw new BrandManagementError(
          "BRAND_MANAGEMENT_DOMAIN_CONFLICT",
          "The hostname is already assigned to a brand record.",
          { hostname, brandDomainId: existingDomain.id }
        );
      }

      return tx.brandDomain.create({
        data: {
          brandProfileId: profile.id,
          hostname,
          type: input.domainType,
          status: "PENDING_CONFIGURATION",
          provider: "VERCEL",
          createdByUserId: actorUserId,
        },
      });
    },
    { isolationLevel: "Serializable" }
  );
}

export async function transitionBrandDomain(
  input: TransitionBrandDomainInput,
  options: BrandManagementServiceOptions = {}
) {
  const db = options.db ?? prisma;
  const now = options.now ?? (() => new Date());
  const domainId = requiredId(input.brandDomainId, "brandDomainId");

  return db.$transaction(
    async (transaction) => {
      const tx = brandManagementTransactionClient(transaction);
      await requireActivePlatformAdmin(tx, input.actor.userId);
      const profile = await requireEnterpriseProfile(
        tx,
        input.brandProfileId
      );
      const domain = await tx.brandDomain.findUnique({
        where: { id: domainId },
        select: {
          id: true,
          brandProfileId: true,
          status: true,
          verifiedAt: true,
          activatedAt: true,
        },
      });
      if (!domain || domain.brandProfileId !== profile.id) {
        throw new BrandManagementError(
          "BRAND_MANAGEMENT_DOMAIN_NOT_FOUND",
          "The domain does not belong to the brand profile.",
          { profileId: profile.id, domainId }
        );
      }

      requireBrandDomainTransition(domain.status, input.toStatus);
      const transitionedAt = now();
      return tx.brandDomain.update({
        where: { id: domain.id },
        data: {
          status: input.toStatus,
          ...(input.providerDomainId !== undefined
            ? { providerDomainId: input.providerDomainId }
            : {}),
          ...(input.redirectUntil !== undefined
            ? { redirectUntil: input.redirectUntil }
            : {}),
          ...(input.toStatus === "ACTIVE"
            ? {
                verifiedAt: domain.verifiedAt ?? transitionedAt,
                activatedAt: domain.activatedAt ?? transitionedAt,
              }
            : {}),
          ...(input.toStatus === "RETIRED"
            ? { retiredAt: transitionedAt }
            : input.toStatus === "VERIFYING"
              ? { retiredAt: null }
              : {}),
        },
      });
    },
    { isolationLevel: "Serializable" }
  );
}

export async function publishEnterpriseBrand(
  input: PublishEnterpriseBrandInput,
  options: BrandManagementServiceOptions = {}
) {
  const db = options.db ?? prisma;
  const revisionId = requiredId(input.brandRevisionId, "brandRevisionId");
  const domainId = requiredId(input.brandDomainId, "brandDomainId");

  return db.$transaction(
    async (transaction) => {
      const tx = brandManagementTransactionClient(transaction);
      const actorUserId = await requireActivePlatformAdmin(
        tx,
        input.actor.userId
      );
      const profile = await requireEnterpriseProfile(
        tx,
        input.brandProfileId
      );
      const revision = await tx.brandRevision.findUnique({
        where: { id: revisionId },
        select: {
          id: true,
          brandProfileId: true,
          displayName: true,
          logoUrl: true,
          faviconUrl: true,
          primaryColor: true,
          approvalStatus: true,
        },
      });
      if (!revision) {
        throw new BrandManagementError(
          "BRAND_MANAGEMENT_REVISION_NOT_FOUND",
          "The brand revision does not exist.",
          { revisionId }
        );
      }

      const domain = await tx.brandDomain.findUnique({
        where: { id: domainId },
        select: {
          id: true,
          brandProfileId: true,
          status: true,
        },
      });
      if (!domain) {
        throw new BrandManagementError(
          "BRAND_MANAGEMENT_DOMAIN_NOT_FOUND",
          "The brand domain does not exist.",
          { domainId }
        );
      }

      requireBrandPublicationReadiness({
        actorRole: "PLATFORM_ADMIN",
        profileId: profile.id,
        profileExperienceType: profile.experienceType,
        profileStatus: profile.status,
        revisionProfileId: revision.brandProfileId,
        revisionApprovalStatus: revision.approvalStatus,
        domainProfileId: domain.brandProfileId,
        domainStatus: domain.status,
        displayName: revision.displayName,
        logoUrl: revision.logoUrl,
        faviconUrl: revision.faviconUrl,
        primaryColor: revision.primaryColor,
      });
      requireBrandProfileTransition(profile.status, "ACTIVE");

      const publishedProfile = await tx.brandProfile.update({
        where: { id: profile.id },
        data: {
          status: "ACTIVE",
          activeRevisionId: revision.id,
          activeDomainId: domain.id,
        },
      });

      return {
        profile: publishedProfile,
        revisionId: revision.id,
        domainId: domain.id,
        publishedByUserId: actorUserId,
      };
    },
    { isolationLevel: "Serializable" }
  );
}

export async function suspendEnterpriseBrand(
  input: SuspendEnterpriseBrandInput,
  options: BrandManagementServiceOptions = {}
) {
  const db = options.db ?? prisma;

  return db.$transaction(
    async (transaction) => {
      const tx = brandManagementTransactionClient(transaction);
      await requireActivePlatformAdmin(tx, input.actor.userId);
      const profile = await requireEnterpriseProfile(
        tx,
        input.brandProfileId
      );
      requireBrandProfileTransition(profile.status, "SUSPENDED");

      return tx.brandProfile.update({
        where: { id: profile.id },
        data: { status: "SUSPENDED" },
      });
    },
    { isolationLevel: "Serializable" }
  );
}
