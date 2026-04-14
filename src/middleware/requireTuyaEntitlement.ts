import type { NextFunction, Request, Response } from "express";

type PrismaLike = any;

export type TuyaAccessState =
  | "locked"
  | "pending_onboarding"
  | "connected";

export type TuyaAccessResult = {
  ok: boolean;
  orgId: string | null;
  state: TuyaAccessState;
  reason:
    | "missing_org"
    | "missing_entitlement"
    | "subscription_inactive"
    | "tuya_not_linked"
    | "tuya_linked";
  source:
    | "organization_flag"
    | "subscription_price"
    | "subscription_flag"
    | "unknown";
  onboardingRequired: boolean;
  hasEntitlement: boolean;
  hasTuyaUid: boolean;
  priceIds: string[];
};

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isTruthyFlag(value: unknown): boolean {
  if (value === true) return true;
  if (value === false || value == null) return false;

  if (typeof value === "number") return value === 1;

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return ["1", "true", "yes", "enabled", "active", "on"].includes(
      normalized
    );
  }

  return false;
}

function uniqueStrings(values: unknown[]): string[] {
  const out = new Set<string>();

  for (const value of values) {
    const s = normalizeString(value);
    if (s) out.add(s);
  }

  return [...out];
}

function resolveOrgId(req: Request): string | null {
  const fromReq = normalizeString((req as any).orgId);
  if (fromReq) return fromReq;

  const fromOrg = normalizeString((req as any).org?.id);
  if (fromOrg) return fromOrg;

  const fromUser = normalizeString((req as any).user?.orgId);
  if (fromUser) return fromUser;

  const fromBody = normalizeString((req as any).body?.organizationId);
  if (fromBody) return fromBody;

  const fromQuery = normalizeString((req as any).query?.organizationId);
  if (fromQuery) return fromQuery;

  return null;
}

function extractTuyaUidFromObject(obj: any): string {
  if (!obj || typeof obj !== "object") return "";

  return normalizeString(
    obj.tuyaUid ??
      obj.tuyaUserUid ??
      obj.tuyaAppUid ??
      obj.tuyaOpenUid ??
      obj.tuyaLinkUid ??
      obj.tuyaAccountUid ??
      obj.tuyaBizUid ??
      obj.tuyaCloudUid
  );
}

function hasTuyaConnectionOnObject(obj: any): boolean {
  if (!obj || typeof obj !== "object") return false;

  const uid = extractTuyaUidFromObject(obj);
  if (uid) return true;

  return (
    isTruthyFlag(obj.tuyaConnected) ||
    isTruthyFlag(obj.isTuyaConnected) ||
    isTruthyFlag(obj.hasTuyaConnection) ||
    isTruthyFlag(obj.integrations?.tuya?.connected) ||
    isTruthyFlag(obj.providers?.tuya?.connected)
  );
}

async function loadOrganization(
  prisma: PrismaLike,
  orgId: string
): Promise<any | null> {
  try {
    const db = prisma as any;
    if (!db?.organization?.findUnique) return null;

    return await db.organization.findUnique({
      where: { id: orgId },
    });
  } catch {
    return null;
  }
}

async function loadLatestSubscription(
  prisma: PrismaLike,
  orgId: string
): Promise<any | null> {
  const db = prisma as any;
  if (!db?.subscription?.findFirst) return null;

  const commonOrderBy = [{ updatedAt: "desc" }, { createdAt: "desc" }];

  try {
    return await db.subscription.findFirst({
      where: { organizationId: orgId },
      orderBy: commonOrderBy,
    });
  } catch {
    // fallback for codebases that use orgId instead of organizationId
  }

  try {
    return await db.subscription.findFirst({
      where: { orgId },
      orderBy: commonOrderBy,
    });
  } catch {
    return null;
  }
}

export async function resolveTuyaAccess(
  prisma: PrismaLike,
  orgId: string | null
): Promise<TuyaAccessResult> {
  if (!orgId) {
    return {
      ok: false,
      orgId: null,
      state: "locked",
      reason: "missing_org",
      source: "unknown",
      onboardingRequired: false,
      hasEntitlement: false,
      hasTuyaUid: false,
      priceIds: [],
    };
  }

  const [organization, subscription] = await Promise.all([
    loadOrganization(prisma, orgId),
    loadLatestSubscription(prisma, orgId),
  ]);

  const subscriptionPriceIds = uniqueStrings([
    subscription?.priceId,
    subscription?.stripePriceId,
    subscription?.addonPriceId,
    subscription?.tuyaPriceId,
    subscription?.metadata?.priceId,
    subscription?.metadata?.tuyaPriceId,
    subscription?.metadata?.addonPriceId,
  ]);

  const hasTuyaUid =
    hasTuyaConnectionOnObject(organization) ||
    hasTuyaConnectionOnObject(subscription);

  // ✅ Nuevo modelo:
  // Tuya ya NO depende de premium / entitlement.
  // La integración técnica existe aparte del consumo smart por property.
  if (!hasTuyaUid) {
    return {
      ok: true,
      orgId,
      state: "pending_onboarding",
      reason: "tuya_not_linked",
      source: "organization_flag",
      onboardingRequired: true,
      hasEntitlement: true,
      hasTuyaUid: false,
      priceIds: subscriptionPriceIds,
    };
  }

  return {
    ok: true,
    orgId,
    state: "connected",
    reason: "tuya_linked",
    source: "organization_flag",
    onboardingRequired: false,
    hasEntitlement: true,
    hasTuyaUid: true,
    priceIds: subscriptionPriceIds,
  };
}

export function requireTuyaEntitlement(prisma: PrismaLike) {
  return async function tuyaEntitlementGuard(
    req: Request,
    res: Response,
    next: NextFunction
  ) {
    try {
      const orgId = resolveOrgId(req);
      const access = await resolveTuyaAccess(prisma, orgId);

      (req as any).tuyaAccess = access;

      if (!access.orgId) {
        return res.status(400).json({
          ok: false,
          error: "ORGANIZATION_ID_REQUIRED",
          tuya: access,
        });
      }

      // ✅ En el nuevo modelo ya no bloqueamos por premium.
      return next();
    } catch (error: any) {
      return res.status(500).json({
        ok: false,
        error: "TUYA_ENTITLEMENT_GUARD_FAILED",
        message:
          error?.message || "Unexpected error while validating Tuya access",
      });
    }
  };
}

export function requireTuyaConnected(prisma: PrismaLike) {
  return async function tuyaConnectedGuard(
    req: Request,
    res: Response,
    next: NextFunction
  ) {
    try {
      const orgId = resolveOrgId(req);
      const access = await resolveTuyaAccess(prisma, orgId);

      (req as any).tuyaAccess = access;

      if (!access.orgId) {
        return res.status(400).json({
          ok: false,
          error: "ORGANIZATION_ID_REQUIRED",
          tuya: access,
        });
      }

      if (access.state !== "connected") {
        return res.status(409).json({
          ok: false,
          error: "TUYA_ONBOARDING_REQUIRED",
          tuya: access,
        });
      }

      return next();
    } catch (error: any) {
      return res.status(500).json({
        ok: false,
        error: "TUYA_CONNECTED_GUARD_FAILED",
        message:
          error?.message || "Unexpected error while validating Tuya connection",
      });
    }
  };
}