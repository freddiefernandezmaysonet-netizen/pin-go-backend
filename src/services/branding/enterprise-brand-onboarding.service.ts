import { createHash, randomBytes } from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import {
  deriveAccessibleBrandTextColor,
  requireBrandManagerRole,
} from "./brand-policy.js";
import type {
  BrandIdentityInput,
  ManagedBrandDomainType,
} from "./brand-management.service.js";
import {
  isPinGoStandardHostname,
  normalizeBrandHostname,
} from "./published-brand-context.service.js";

const OWNER_INVITATION_LIFETIME_MS = 72 * 60 * 60 * 1000;
const OWNER_INVITATION_TOKEN_LENGTH = 43;

const RESERVED_ORGANIZATION_SLUGS = new Set([
  "admin",
  "api",
  "app",
  "auth",
  "pin-go",
  "pingo",
  "public",
  "support",
  "www",
]);

export type EnterpriseBrandOnboardingErrorCode =
  | "ENTERPRISE_BRAND_ONBOARDING_INPUT_INVALID"
  | "ENTERPRISE_BRAND_ONBOARDING_ACTOR_NOT_FOUND"
  | "ENTERPRISE_BRAND_ONBOARDING_ACTOR_INACTIVE"
  | "ENTERPRISE_BRAND_ONBOARDING_SLUG_CONFLICT"
  | "ENTERPRISE_BRAND_ONBOARDING_EMAIL_REGISTERED"
  | "ENTERPRISE_BRAND_ONBOARDING_DOMAIN_CONFLICT"
  | "ENTERPRISE_BRAND_ONBOARDING_DOMAIN_TYPE_INVALID"
  | "ENTERPRISE_BRAND_ONBOARDING_IDENTITY_INVALID"
  | "ENTERPRISE_BRAND_ONBOARDING_CONFLICT";

export class EnterpriseBrandOnboardingError extends Error {
  constructor(
    readonly code: EnterpriseBrandOnboardingErrorCode,
    message: string,
    readonly context: Readonly<Record<string, unknown>> = {}
  ) {
    super(`${code}: ${message}`);
    this.name = "EnterpriseBrandOnboardingError";
  }
}

export type ProvisionEnterpriseBrandOrganizationInput = {
  actor: {
    userId: string;
  };
  organizationName: string;
  organizationSlug: string;
  ownerEmail: string;
  identity: BrandIdentityInput;
  hostname: string;
  domainType: ManagedBrandDomainType;
};

export type EnterpriseBrandOnboardingServiceOptions = {
  db?: typeof prisma;
  now?: () => Date;
  generateToken?: () => string;
};

type EnterpriseBrandOnboardingTransactionClient = Pick<
  typeof prisma,
  | "dashboardUser"
  | "organization"
  | "brandProfile"
  | "brandRevision"
  | "brandDomain"
  | "organizationInvitation"
>;

function onboardingTransactionClient(
  transaction: unknown
): EnterpriseBrandOnboardingTransactionClient {
  return transaction as EnterpriseBrandOnboardingTransactionClient;
}

function inputError(field: string, message: string): never {
  throw new EnterpriseBrandOnboardingError(
    "ENTERPRISE_BRAND_ONBOARDING_INPUT_INVALID",
    message,
    { field }
  );
}

function requiredText(
  value: string | null | undefined,
  field: string
): string {
  const normalized = String(value ?? "").trim();
  if (!normalized) inputError(field, `${field} is required.`);
  return normalized;
}

function normalizeOrganizationName(rawName: string): string {
  const name = requiredText(rawName, "organizationName");
  if (name.length < 2 || name.length > 120 || /[\r\n]/.test(name)) {
    inputError(
      "organizationName",
      "organizationName must contain between 2 and 120 characters on one line."
    );
  }
  return name;
}

function normalizeOrganizationSlug(rawSlug: string): string {
  const slug = requiredText(rawSlug, "organizationSlug").toLowerCase();
  if (
    slug.length < 3 ||
    slug.length > 80 ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) ||
    RESERVED_ORGANIZATION_SLUGS.has(slug)
  ) {
    inputError(
      "organizationSlug",
      "organizationSlug must be an available lowercase kebab-case value between 3 and 80 characters."
    );
  }
  return slug;
}

function normalizeOwnerEmail(rawEmail: string): string {
  const email = requiredText(rawEmail, "ownerEmail").toLowerCase();
  if (
    email.length > 320 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  ) {
    inputError("ownerEmail", "ownerEmail must be a valid email address.");
  }
  return email;
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
    throw new EnterpriseBrandOnboardingError(
      "ENTERPRISE_BRAND_ONBOARDING_IDENTITY_INVALID",
      `${field} must be a secure HTTPS URL without credentials.`,
      { field }
    );
  }
  return normalized;
}

function assetPublicId(value: string, field: string): string {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized.length > 255) {
    throw new EnterpriseBrandOnboardingError(
      "ENTERPRISE_BRAND_ONBOARDING_IDENTITY_INVALID",
      `${field} must contain between 1 and 255 characters.`,
      { field }
    );
  }
  return normalized;
}

function normalizeIdentity(identity: BrandIdentityInput): BrandIdentityInput {
  const displayName = String(identity?.displayName ?? "").trim();
  if (displayName.length < 2 || displayName.length > 100) {
    throw new EnterpriseBrandOnboardingError(
      "ENTERPRISE_BRAND_ONBOARDING_IDENTITY_INVALID",
      "displayName must contain between 2 and 100 characters.",
      { field: "displayName" }
    );
  }

  const primaryColor = String(identity?.primaryColor ?? "")
    .trim()
    .toUpperCase();
  if (
    !/^#[0-9A-F]{6}$/.test(primaryColor) ||
    !deriveAccessibleBrandTextColor(primaryColor)
  ) {
    throw new EnterpriseBrandOnboardingError(
      "ENTERPRISE_BRAND_ONBOARDING_IDENTITY_INVALID",
      "primaryColor must be accessible and use #RRGGBB format.",
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
  if (
    domainType !== "PINNGO_SUBDOMAIN" &&
    domainType !== "CUSTOM_DOMAIN"
  ) {
    throw new EnterpriseBrandOnboardingError(
      "ENTERPRISE_BRAND_ONBOARDING_DOMAIN_TYPE_INVALID",
      "domainType must be PINNGO_SUBDOMAIN or CUSTOM_DOMAIN.",
      { domainType }
    );
  }

  const hostname = normalizeBrandHostname(rawHostname);
  if (!hostname || isPinGoStandardHostname(hostname)) {
    throw new EnterpriseBrandOnboardingError(
      "ENTERPRISE_BRAND_ONBOARDING_DOMAIN_CONFLICT",
      "The hostname is invalid or reserved by Pin&Go."
    );
  }

  const pinGoSuffix = ".pin-ngo.com";
  const isPinGoSubdomain = hostname.endsWith(pinGoSuffix);
  if (domainType === "PINNGO_SUBDOMAIN") {
    const prefix = hostname.slice(0, -pinGoSuffix.length);
    if (!isPinGoSubdomain || !prefix || prefix.includes(".")) {
      throw new EnterpriseBrandOnboardingError(
        "ENTERPRISE_BRAND_ONBOARDING_DOMAIN_TYPE_INVALID",
        "PINNGO_SUBDOMAIN must be one direct subdomain of pin-ngo.com.",
        { hostname }
      );
    }
  } else if (isPinGoSubdomain) {
    throw new EnterpriseBrandOnboardingError(
      "ENTERPRISE_BRAND_ONBOARDING_DOMAIN_TYPE_INVALID",
      "A pin-ngo.com hostname must use PINNGO_SUBDOMAIN.",
      { hostname }
    );
  }

  return hostname;
}

function generateOwnerInvitationToken(): string {
  return randomBytes(32).toString("base64url");
}

function normalizeGeneratedToken(rawToken: string): string {
  const token = requiredText(rawToken, "generatedToken");
  if (
    token.length !== OWNER_INVITATION_TOKEN_LENGTH ||
    !/^[A-Za-z0-9_-]+$/.test(token)
  ) {
    inputError(
      "generatedToken",
      "The generated owner invitation token is invalid."
    );
  }
  return token;
}

function hashOwnerInvitationToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

async function requireActivePlatformAdmin(
  tx: EnterpriseBrandOnboardingTransactionClient,
  rawUserId: string
): Promise<string> {
  const userId = requiredText(rawUserId, "actor.userId");
  const actor = await tx.dashboardUser.findUnique({
    where: { id: userId },
    select: {
      id: true,
      role: true,
      isActive: true,
    },
  });
  if (!actor) {
    throw new EnterpriseBrandOnboardingError(
      "ENTERPRISE_BRAND_ONBOARDING_ACTOR_NOT_FOUND",
      "The onboarding manager account does not exist.",
      { userId }
    );
  }
  if (!actor.isActive) {
    throw new EnterpriseBrandOnboardingError(
      "ENTERPRISE_BRAND_ONBOARDING_ACTOR_INACTIVE",
      "The onboarding manager account is inactive.",
      { userId }
    );
  }
  requireBrandManagerRole(actor.role);
  return actor.id;
}

function isPrismaUniqueConstraintError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "P2002"
  );
}

export async function provisionEnterpriseBrandOrganization(
  input: ProvisionEnterpriseBrandOrganizationInput,
  options: EnterpriseBrandOnboardingServiceOptions = {}
) {
  const db = options.db ?? prisma;
  const now = options.now ?? (() => new Date());
  const generateToken = options.generateToken ?? generateOwnerInvitationToken;
  const organizationName = normalizeOrganizationName(
    input.organizationName
  );
  const organizationSlug = normalizeOrganizationSlug(
    input.organizationSlug
  );
  const ownerEmail = normalizeOwnerEmail(input.ownerEmail);
  const identity = normalizeIdentity(input.identity);
  const hostname = normalizeManagedHostname(
    input.hostname,
    input.domainType
  );
  const invitationToken = normalizeGeneratedToken(generateToken());
  const invitationTokenHash = hashOwnerInvitationToken(invitationToken);
  const provisionedAt = now();
  const invitationExpiresAt = new Date(
    provisionedAt.getTime() + OWNER_INVITATION_LIFETIME_MS
  );

  try {
    const provisioned = await db.$transaction(
      async (transaction) => {
        const tx = onboardingTransactionClient(transaction);
        const actorUserId = await requireActivePlatformAdmin(
          tx,
          input.actor.userId
        );

        const existingOrganization = await tx.organization.findUnique({
          where: { slug: organizationSlug },
          select: { id: true },
        });
        if (existingOrganization) {
          throw new EnterpriseBrandOnboardingError(
            "ENTERPRISE_BRAND_ONBOARDING_SLUG_CONFLICT",
            "The organization slug is already in use.",
            { organizationSlug }
          );
        }

        const existingUser = await tx.dashboardUser.findUnique({
          where: { email: ownerEmail },
          select: { id: true },
        });
        if (existingUser) {
          throw new EnterpriseBrandOnboardingError(
            "ENTERPRISE_BRAND_ONBOARDING_EMAIL_REGISTERED",
            "The owner email already belongs to a dashboard user.",
            { ownerEmail }
          );
        }

        const existingDomain = await tx.brandDomain.findUnique({
          where: { hostname },
          select: { id: true },
        });
        if (existingDomain) {
          throw new EnterpriseBrandOnboardingError(
            "ENTERPRISE_BRAND_ONBOARDING_DOMAIN_CONFLICT",
            "The hostname is already assigned to a brand record.",
            { hostname }
          );
        }

        // This explicit PLATFORM_ADMIN action is the V1 commercial approval.
        // Property count is intentionally not inferred or enforced here.
        const organization = await tx.organization.create({
          data: {
            name: organizationName,
            slug: organizationSlug,
          },
          select: {
            id: true,
            name: true,
            slug: true,
            createdAt: true,
          },
        });
        const profile = await tx.brandProfile.create({
          data: {
            organizationId: organization.id,
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
        const invitation = await tx.organizationInvitation.create({
          data: {
            organizationId: organization.id,
            email: ownerEmail,
            role: "ORG_ADMIN",
            tokenHash: invitationTokenHash,
            expiresAt: invitationExpiresAt,
            createdByUserId: actorUserId,
          },
          select: {
            id: true,
            organizationId: true,
            email: true,
            role: true,
            expiresAt: true,
            createdAt: true,
          },
        });

        return {
          organization,
          profile,
          revision,
          domain,
          invitation,
        };
      },
      { isolationLevel: "Serializable" }
    );

    return {
      ...provisioned,
      invitationToken,
    };
  } catch (error) {
    if (error instanceof EnterpriseBrandOnboardingError) throw error;
    if (isPrismaUniqueConstraintError(error)) {
      throw new EnterpriseBrandOnboardingError(
        "ENTERPRISE_BRAND_ONBOARDING_CONFLICT",
        "A unique organization, domain, email, or token value changed during provisioning."
      );
    }
    throw error;
  }
}
