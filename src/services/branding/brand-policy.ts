export type BrandActorRole =
  | "ADMIN"
  | "MEMBER"
  | "PLATFORM_ADMIN"
  | "ORG_ADMIN";

export type BrandExperienceType = "STANDARD" | "ENTERPRISE_BRANDED";

export type BrandProfileStatus = "DRAFT" | "ACTIVE" | "SUSPENDED";

export type BrandRevisionApprovalStatus =
  | "DRAFT"
  | "PENDING_APPROVAL"
  | "APPROVED"
  | "REJECTED";

export type BrandDomainStatus =
  | "PENDING_CONFIGURATION"
  | "PENDING_DNS"
  | "VERIFYING"
  | "ACTIVE"
  | "FAILED"
  | "RETIRED";

export type BrandPolicyErrorCode =
  | "BRAND_MANAGER_REQUIRED"
  | "BRAND_REVIEWER_REQUIRED"
  | "BRAND_REVIEW_ORGANIZATION_MISMATCH"
  | "BRAND_PROFILE_TRANSITION_INVALID"
  | "BRAND_REVISION_TRANSITION_INVALID"
  | "BRAND_DOMAIN_TRANSITION_INVALID"
  | "BRAND_PUBLICATION_NOT_READY";

export class BrandPolicyError extends Error {
  constructor(
    readonly code: BrandPolicyErrorCode,
    message: string,
    readonly context: Readonly<Record<string, unknown>> = {}
  ) {
    super(`${code}: ${message}`);
    this.name = "BrandPolicyError";
  }
}

const BRAND_REVIEWER_ROLES: readonly BrandActorRole[] = [
  "ADMIN",
  "ORG_ADMIN",
];

const PROFILE_TRANSITIONS: Readonly<
  Record<BrandProfileStatus, readonly BrandProfileStatus[]>
> = {
  DRAFT: ["DRAFT", "ACTIVE", "SUSPENDED"],
  ACTIVE: ["ACTIVE", "SUSPENDED"],
  SUSPENDED: ["SUSPENDED", "ACTIVE"],
};

const REVISION_TRANSITIONS: Readonly<
  Record<
    BrandRevisionApprovalStatus,
    readonly BrandRevisionApprovalStatus[]
  >
> = {
  DRAFT: ["DRAFT", "PENDING_APPROVAL"],
  PENDING_APPROVAL: ["APPROVED", "REJECTED"],
  APPROVED: ["APPROVED"],
  REJECTED: ["REJECTED"],
};

const DOMAIN_TRANSITIONS: Readonly<
  Record<BrandDomainStatus, readonly BrandDomainStatus[]>
> = {
  PENDING_CONFIGURATION: [
    "PENDING_CONFIGURATION",
    "PENDING_DNS",
    "VERIFYING",
    "FAILED",
    "RETIRED",
  ],
  PENDING_DNS: ["PENDING_DNS", "VERIFYING", "FAILED", "RETIRED"],
  VERIFYING: [
    "VERIFYING",
    "PENDING_DNS",
    "ACTIVE",
    "FAILED",
    "RETIRED",
  ],
  ACTIVE: ["ACTIVE", "FAILED", "RETIRED"],
  FAILED: [
    "FAILED",
    "PENDING_CONFIGURATION",
    "PENDING_DNS",
    "VERIFYING",
    "RETIRED",
  ],
  RETIRED: ["RETIRED", "VERIFYING"],
};

export function isBrandManagerRole(
  role: BrandActorRole | null | undefined
): role is "PLATFORM_ADMIN" {
  return role === "PLATFORM_ADMIN";
}

export function requireBrandManagerRole(
  role: BrandActorRole | null | undefined
): void {
  if (!isBrandManagerRole(role)) {
    throw new BrandPolicyError(
      "BRAND_MANAGER_REQUIRED",
      "Only PLATFORM_ADMIN can manage organization branding.",
      { role: role ?? null }
    );
  }
}

export function isBrandReviewerRole(
  role: BrandActorRole | null | undefined
): role is "ADMIN" | "ORG_ADMIN" {
  return Boolean(role && BRAND_REVIEWER_ROLES.includes(role));
}

export type BrandReviewAuthorizationInput = {
  role: BrandActorRole | null | undefined;
  actorOrganizationId: string | null | undefined;
  brandOrganizationId: string;
};

export function requireBrandReviewAuthorization(
  input: BrandReviewAuthorizationInput
): void {
  if (!isBrandReviewerRole(input.role)) {
    throw new BrandPolicyError(
      "BRAND_REVIEWER_REQUIRED",
      "Brand approval requires ADMIN or ORG_ADMIN.",
      { role: input.role ?? null }
    );
  }

  if (
    !input.actorOrganizationId ||
    input.actorOrganizationId !== input.brandOrganizationId
  ) {
    throw new BrandPolicyError(
      "BRAND_REVIEW_ORGANIZATION_MISMATCH",
      "The reviewer must belong to the branded organization.",
      {
        actorOrganizationId: input.actorOrganizationId ?? null,
        brandOrganizationId: input.brandOrganizationId,
      }
    );
  }
}

export function isBrandProfileTransitionAllowed(
  from: BrandProfileStatus,
  to: BrandProfileStatus
): boolean {
  return PROFILE_TRANSITIONS[from].includes(to);
}

export function requireBrandProfileTransition(
  from: BrandProfileStatus,
  to: BrandProfileStatus
): void {
  if (!isBrandProfileTransitionAllowed(from, to)) {
    throw new BrandPolicyError(
      "BRAND_PROFILE_TRANSITION_INVALID",
      `${from} cannot transition to ${to}.`,
      { from, to }
    );
  }
}

export function isBrandRevisionTransitionAllowed(
  from: BrandRevisionApprovalStatus,
  to: BrandRevisionApprovalStatus
): boolean {
  return REVISION_TRANSITIONS[from].includes(to);
}

export function requireBrandRevisionTransition(
  from: BrandRevisionApprovalStatus,
  to: BrandRevisionApprovalStatus
): void {
  if (!isBrandRevisionTransitionAllowed(from, to)) {
    throw new BrandPolicyError(
      "BRAND_REVISION_TRANSITION_INVALID",
      `${from} cannot transition to ${to}.`,
      { from, to }
    );
  }
}

export function isBrandDomainTransitionAllowed(
  from: BrandDomainStatus,
  to: BrandDomainStatus
): boolean {
  return DOMAIN_TRANSITIONS[from].includes(to);
}

export function requireBrandDomainTransition(
  from: BrandDomainStatus,
  to: BrandDomainStatus
): void {
  if (!isBrandDomainTransitionAllowed(from, to)) {
    throw new BrandPolicyError(
      "BRAND_DOMAIN_TRANSITION_INVALID",
      `${from} cannot transition to ${to}.`,
      { from, to }
    );
  }
}

export type BrandPublicationReadinessInput = {
  actorRole: BrandActorRole | null | undefined;
  profileId: string;
  profileExperienceType: BrandExperienceType;
  profileStatus: BrandProfileStatus;
  revisionProfileId: string;
  revisionApprovalStatus: BrandRevisionApprovalStatus;
  domainProfileId: string;
  domainStatus: BrandDomainStatus;
  displayName: string;
  logoUrl: string;
  faviconUrl: string;
  primaryColor: string;
};

export type BrandPublicationCheckCode =
  | "PLATFORM_ADMIN_ACTOR"
  | "ENTERPRISE_BRANDED_PROFILE"
  | "PROFILE_NOT_SUSPENDED"
  | "REVISION_BELONGS_TO_PROFILE"
  | "DOMAIN_BELONGS_TO_PROFILE"
  | "REVISION_APPROVED"
  | "DOMAIN_ACTIVE"
  | "DISPLAY_NAME_VALID"
  | "LOGO_URL_SECURE"
  | "FAVICON_URL_SECURE"
  | "PRIMARY_COLOR_VALID"
  | "PRIMARY_COLOR_CONTRAST";

export type BrandPublicationCheck = {
  code: BrandPublicationCheckCode;
  passed: boolean;
};

function isSecureAssetUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      Boolean(url.hostname)
    );
  } catch {
    return false;
  }
}

function isValidPrimaryColor(value: string): boolean {
  return /^#[0-9A-F]{6}$/i.test(value);
}

function srgbChannelToLinear(channel: number): number {
  const normalized = channel / 255;
  return normalized <= 0.04045
    ? normalized / 12.92
    : ((normalized + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(hexColor: string): number | null {
  if (!isValidPrimaryColor(hexColor)) return null;

  const red = Number.parseInt(hexColor.slice(1, 3), 16);
  const green = Number.parseInt(hexColor.slice(3, 5), 16);
  const blue = Number.parseInt(hexColor.slice(5, 7), 16);

  return (
    0.2126 * srgbChannelToLinear(red) +
    0.7152 * srgbChannelToLinear(green) +
    0.0722 * srgbChannelToLinear(blue)
  );
}

function contrastRatio(first: number, second: number): number {
  const lighter = Math.max(first, second);
  const darker = Math.min(first, second);
  return (lighter + 0.05) / (darker + 0.05);
}

export function deriveAccessibleBrandTextColor(
  primaryColor: string
): "#000000" | "#FFFFFF" | null {
  const luminance = relativeLuminance(primaryColor);
  if (luminance === null) return null;

  const blackContrast = contrastRatio(luminance, 0);
  const whiteContrast = contrastRatio(luminance, 1);
  const selected =
    blackContrast >= whiteContrast
      ? { color: "#000000" as const, contrast: blackContrast }
      : { color: "#FFFFFF" as const, contrast: whiteContrast };

  return selected.contrast >= 4.5 ? selected.color : null;
}

export function evaluateBrandPublicationReadiness(
  input: BrandPublicationReadinessInput
): {
  ready: boolean;
  onPrimaryColor: "#000000" | "#FFFFFF" | null;
  checks: BrandPublicationCheck[];
} {
  const onPrimaryColor = deriveAccessibleBrandTextColor(input.primaryColor);
  const checks: BrandPublicationCheck[] = [
    {
      code: "PLATFORM_ADMIN_ACTOR",
      passed: isBrandManagerRole(input.actorRole),
    },
    {
      code: "ENTERPRISE_BRANDED_PROFILE",
      passed: input.profileExperienceType === "ENTERPRISE_BRANDED",
    },
    {
      code: "PROFILE_NOT_SUSPENDED",
      passed: input.profileStatus !== "SUSPENDED",
    },
    {
      code: "REVISION_BELONGS_TO_PROFILE",
      passed: input.revisionProfileId === input.profileId,
    },
    {
      code: "DOMAIN_BELONGS_TO_PROFILE",
      passed: input.domainProfileId === input.profileId,
    },
    {
      code: "REVISION_APPROVED",
      passed: input.revisionApprovalStatus === "APPROVED",
    },
    {
      code: "DOMAIN_ACTIVE",
      passed: input.domainStatus === "ACTIVE",
    },
    {
      code: "DISPLAY_NAME_VALID",
      passed:
        input.displayName.trim().length >= 2 &&
        input.displayName.trim().length <= 100,
    },
    {
      code: "LOGO_URL_SECURE",
      passed: isSecureAssetUrl(input.logoUrl),
    },
    {
      code: "FAVICON_URL_SECURE",
      passed: isSecureAssetUrl(input.faviconUrl),
    },
    {
      code: "PRIMARY_COLOR_VALID",
      passed: isValidPrimaryColor(input.primaryColor),
    },
    {
      code: "PRIMARY_COLOR_CONTRAST",
      passed: onPrimaryColor !== null,
    },
  ];

  return {
    ready: checks.every((check) => check.passed),
    onPrimaryColor,
    checks,
  };
}

export function requireBrandPublicationReadiness(
  input: BrandPublicationReadinessInput
): ReturnType<typeof evaluateBrandPublicationReadiness> {
  const result = evaluateBrandPublicationReadiness(input);
  if (!result.ready) {
    throw new BrandPolicyError(
      "BRAND_PUBLICATION_NOT_READY",
      "One or more publication preconditions failed.",
      {
        failedChecks: result.checks
          .filter((check) => !check.passed)
          .map((check) => check.code),
      }
    );
  }

  return result;
}
