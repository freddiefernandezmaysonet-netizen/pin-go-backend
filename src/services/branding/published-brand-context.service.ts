import type { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { deriveAccessibleBrandTextColor } from "./brand-policy.js";

const STANDARD_PIN_GO_HOSTNAMES = new Set([
  "app.pin-ngo.com",
  "api.pin-ngo.com",
  "pin-ngo.com",
  "www.pin-ngo.com",
  "localhost",
  "127.0.0.1",
]);

const PUBLISHED_PROFILE_SELECT = {
  id: true,
  organizationId: true,
  experienceType: true,
  status: true,
  activeRevisionId: true,
  activeDomainId: true,
  organization: {
    select: {
      id: true,
      slug: true,
    },
  },
  activeRevision: {
    select: {
      id: true,
      brandProfileId: true,
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
      brandProfileId: true,
      hostname: true,
      status: true,
    },
  },
} as const;

type PublishedBrandProfileRecord = Prisma.BrandProfileGetPayload<{
  select: typeof PUBLISHED_PROFILE_SELECT;
}>;

export type PinGoStandardBrandContext = {
  kind: "PIN_GO_STANDARD";
  displayName: "Pin&Go";
  logoUrl: null;
  faviconUrl: null;
  primaryColor: null;
  onPrimaryColor: null;
  organizationId: null;
  organizationSlug: null;
  revisionId: null;
  version: null;
  customDomain: null;
  poweredByPinGo: true;
};

export type CustomPublishedBrandContext = {
  kind: "CUSTOM_BRAND";
  displayName: string;
  logoUrl: string;
  faviconUrl: string;
  primaryColor: string;
  onPrimaryColor: "#000000" | "#FFFFFF";
  organizationId: string;
  organizationSlug: string | null;
  revisionId: string;
  version: number;
  customDomain: string;
  poweredByPinGo: true;
};

export type PublishedBrandContext =
  | PinGoStandardBrandContext
  | CustomPublishedBrandContext;

export type BrandDomainUnavailableReason =
  | "INVALID_HOSTNAME"
  | "CUSTOM_BRANDING_DISABLED"
  | "DOMAIN_NOT_FOUND"
  | "DOMAIN_NOT_ACTIVE"
  | "ACTIVE_DOMAIN_MISMATCH"
  | "PROFILE_NOT_ACTIVE"
  | "PROFILE_NOT_ENTERPRISE_BRANDED"
  | "REVISION_NOT_PUBLISHED"
  | "REVISION_PROFILE_MISMATCH"
  | "BRAND_IDENTITY_INVALID";

export type BrandDomainUnavailableContext = {
  kind: "DOMAIN_UNAVAILABLE";
  hostname: string | null;
  reason: BrandDomainUnavailableReason;
  poweredByPinGo: true;
};

export type HostnameBrandResolution =
  | PublishedBrandContext
  | BrandDomainUnavailableContext;

export type PublishedBrandContextResolverOptions = {
  db?: typeof prisma;
  brandingEnabled?: boolean;
};

export const PIN_GO_STANDARD_BRAND_CONTEXT: PinGoStandardBrandContext =
  Object.freeze({
    kind: "PIN_GO_STANDARD",
    displayName: "Pin&Go",
    logoUrl: null,
    faviconUrl: null,
    primaryColor: null,
    onPrimaryColor: null,
    organizationId: null,
    organizationSlug: null,
    revisionId: null,
    version: null,
    customDomain: null,
    poweredByPinGo: true,
  });

function isCustomBrandingEnabled(): boolean {
  return (
    String(process.env.CUSTOM_BRANDING_V1_ENABLED ?? "")
      .trim()
      .toLowerCase() === "true"
  );
}

function stripOptionalPort(hostname: string): string | null {
  const colonCount = [...hostname].filter((character) => character === ":")
    .length;

  if (colonCount === 0) return hostname;
  if (colonCount !== 1) return null;

  const separatorIndex = hostname.lastIndexOf(":");
  const port = hostname.slice(separatorIndex + 1);
  if (!/^\d{1,5}$/.test(port)) return null;

  const portNumber = Number(port);
  if (portNumber < 1 || portNumber > 65_535) return null;

  return hostname.slice(0, separatorIndex);
}

export function normalizeBrandHostname(
  rawHostname: string | null | undefined
): string | null {
  const trimmed = String(rawHostname ?? "").trim().toLowerCase();
  if (
    !trimmed ||
    trimmed.includes(",") ||
    trimmed.includes("/") ||
    trimmed.includes("\\") ||
    trimmed.includes("@") ||
    trimmed.includes("://") ||
    /\s/.test(trimmed)
  ) {
    return null;
  }

  const withoutPort = stripOptionalPort(trimmed);
  const normalized = withoutPort?.replace(/\.$/, "") ?? "";
  if (!normalized || normalized.length > 253) return null;

  if (normalized === "localhost") return normalized;

  const labels = normalized.split(".");
  if (labels.length < 2) return null;
  if (labels.some((label) => !label || label.length > 63)) return null;
  if (
    labels.some(
      (label) =>
        !/^[a-z0-9-]+$/.test(label) ||
        label.startsWith("-") ||
        label.endsWith("-")
    )
  ) {
    return null;
  }

  return normalized;
}

export function isPinGoStandardHostname(hostname: string): boolean {
  return STANDARD_PIN_GO_HOSTNAMES.has(hostname);
}

function unavailable(
  hostname: string | null,
  reason: BrandDomainUnavailableReason
): BrandDomainUnavailableContext {
  return {
    kind: "DOMAIN_UNAVAILABLE",
    hostname,
    reason,
    poweredByPinGo: true,
  };
}

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

function buildCustomBrandContext(
  profile: PublishedBrandProfileRecord | null
): CustomPublishedBrandContext | BrandDomainUnavailableContext {
  if (!profile) {
    return unavailable(null, "ACTIVE_DOMAIN_MISMATCH");
  }

  if (profile.status !== "ACTIVE") {
    return unavailable(
      profile.activeDomain?.hostname ?? null,
      "PROFILE_NOT_ACTIVE"
    );
  }

  if (profile.experienceType !== "ENTERPRISE_BRANDED") {
    return unavailable(
      profile.activeDomain?.hostname ?? null,
      "PROFILE_NOT_ENTERPRISE_BRANDED"
    );
  }

  const domain = profile.activeDomain;
  if (
    !domain ||
    domain.status !== "ACTIVE" ||
    domain.id !== profile.activeDomainId ||
    domain.brandProfileId !== profile.id
  ) {
    return unavailable(
      domain?.hostname ?? null,
      "ACTIVE_DOMAIN_MISMATCH"
    );
  }

  const revision = profile.activeRevision;
  if (
    !revision ||
    revision.id !== profile.activeRevisionId ||
    revision.approvalStatus !== "APPROVED"
  ) {
    return unavailable(domain.hostname, "REVISION_NOT_PUBLISHED");
  }

  if (revision.brandProfileId !== profile.id) {
    return unavailable(domain.hostname, "REVISION_PROFILE_MISMATCH");
  }

  const displayName = revision.displayName.trim();
  const onPrimaryColor = deriveAccessibleBrandTextColor(
    revision.primaryColor
  );
  if (
    displayName.length < 2 ||
    displayName.length > 100 ||
    !isSecureAssetUrl(revision.logoUrl) ||
    !isSecureAssetUrl(revision.faviconUrl) ||
    !onPrimaryColor
  ) {
    return unavailable(domain.hostname, "BRAND_IDENTITY_INVALID");
  }

  return {
    kind: "CUSTOM_BRAND",
    displayName,
    logoUrl: revision.logoUrl,
    faviconUrl: revision.faviconUrl,
    primaryColor: revision.primaryColor.toUpperCase(),
    onPrimaryColor,
    organizationId: profile.organization.id,
    organizationSlug: profile.organization.slug,
    revisionId: revision.id,
    version: revision.version,
    customDomain: domain.hostname,
    poweredByPinGo: true,
  };
}

export async function resolvePublishedBrandContextByHostname(
  rawHostname: string | null | undefined,
  options: PublishedBrandContextResolverOptions = {}
): Promise<HostnameBrandResolution> {
  const hostname = normalizeBrandHostname(rawHostname);
  if (!hostname) return unavailable(null, "INVALID_HOSTNAME");

  if (isPinGoStandardHostname(hostname)) {
    return PIN_GO_STANDARD_BRAND_CONTEXT;
  }

  const brandingEnabled =
    options.brandingEnabled ?? isCustomBrandingEnabled();
  if (!brandingEnabled) {
    return unavailable(hostname, "CUSTOM_BRANDING_DISABLED");
  }

  const db = options.db ?? prisma;
  const domain = await db.brandDomain.findUnique({
    where: { hostname },
    select: {
      id: true,
      status: true,
    },
  });

  if (!domain) return unavailable(hostname, "DOMAIN_NOT_FOUND");
  if (domain.status !== "ACTIVE") {
    return unavailable(hostname, "DOMAIN_NOT_ACTIVE");
  }

  const profile = await db.brandProfile.findUnique({
    where: { activeDomainId: domain.id },
    select: PUBLISHED_PROFILE_SELECT,
  });
  if (!profile) return unavailable(hostname, "ACTIVE_DOMAIN_MISMATCH");

  const context = buildCustomBrandContext(profile);
  if (
    context.kind === "CUSTOM_BRAND" &&
    context.customDomain !== hostname
  ) {
    return unavailable(hostname, "ACTIVE_DOMAIN_MISMATCH");
  }

  return context;
}

export async function resolvePublishedBrandContextForOrganization(
  organizationId: string,
  options: PublishedBrandContextResolverOptions = {}
): Promise<PublishedBrandContext> {
  const normalizedOrganizationId = organizationId.trim();
  if (!normalizedOrganizationId) return PIN_GO_STANDARD_BRAND_CONTEXT;

  const brandingEnabled =
    options.brandingEnabled ?? isCustomBrandingEnabled();
  if (!brandingEnabled) return PIN_GO_STANDARD_BRAND_CONTEXT;

  const db = options.db ?? prisma;
  const profile = await db.brandProfile.findUnique({
    where: { organizationId: normalizedOrganizationId },
    select: PUBLISHED_PROFILE_SELECT,
  });
  const context = buildCustomBrandContext(profile);

  return context.kind === "CUSTOM_BRAND"
    ? context
    : PIN_GO_STANDARD_BRAND_CONTEXT;
}
