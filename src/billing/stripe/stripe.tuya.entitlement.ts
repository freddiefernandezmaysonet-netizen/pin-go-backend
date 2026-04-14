type PrismaLike = any;

type StripeEventLike = {
  type?: string;
  data?: {
    object?: any;
  };
};

type TuyaEntitlementSyncResult = {
  handled: boolean;
  matched: boolean;
  orgId: string | null;
  enabled: boolean | null;
  reason:
    | "missing_event"
    | "unsupported_event"
    | "missing_object"
    | "missing_org"
    | "not_tuya"
    | "enabled"
    | "disabled"
    | "noop";
};

const ACTIVE_SUBSCRIPTION_STATUSES = new Set([
  "active",
  "trialing",
  "past_due",
]);

const INACTIVE_SUBSCRIPTION_STATUSES = new Set([
  "canceled",
  "unpaid",
  "incomplete_expired",
  "paused",
]);

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeLower(value: unknown): string {
  return normalizeString(value).toLowerCase();
}

function uniqueStrings(values: unknown[]): string[] {
  const out = new Set<string>();

  for (const value of values) {
    const s = normalizeString(value);
    if (s) out.add(s);
  }

  return [...out];
}

function asPlainObject(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, any>)
    : {};
}

function getConfiguredTuyaPriceIds(): string[] {
  return uniqueStrings([
    process.env.STRIPE_PRICE_TUYA_ADDON,
    process.env.STRIPE_PRICE_TUYA_MONTHLY,
    process.env.STRIPE_PRICE_TUYA_PREMIUM,
    process.env.STRIPE_PRICE_TUYA,
  ]);
}

function getEventObject(event: StripeEventLike): any | null {
  return event?.data?.object ?? null;
}

function getMetadata(obj: any): Record<string, any> {
  if (!obj || typeof obj !== "object") return {};
  if (obj.metadata && typeof obj.metadata === "object") return obj.metadata;
  return {};
}

function getLineItemsPriceIds(obj: any): string[] {
  if (!obj || typeof obj !== "object") return [];

  const directItems = Array.isArray(obj.items?.data) ? obj.items.data : [];
  const sessionLineItems = Array.isArray(obj.line_items?.data) ? obj.line_items.data : [];
  const displayItems = Array.isArray(obj.display_items) ? obj.display_items : [];

  const values: unknown[] = [];

  for (const item of [...directItems, ...sessionLineItems, ...displayItems]) {
    values.push(
      item?.price?.id,
      item?.plan?.id,
      item?.priceId,
      item?.stripePriceId
    );
  }

  return uniqueStrings(values);
}

function getDirectCandidatePriceIds(obj: any): string[] {
  if (!obj || typeof obj !== "object") return [];

  return uniqueStrings([
    obj.price?.id,
    obj.plan?.id,
    obj.priceId,
    obj.stripePriceId,
    obj.metadata?.priceId,
    obj.metadata?.tuyaPriceId,
    obj.metadata?.addonPriceId,
    ...getLineItemsPriceIds(obj),
  ]);
}

function isTuyaFeatureByMetadata(obj: any): boolean {
  const metadata = getMetadata(obj);

  const feature = normalizeLower(metadata.feature);
  const addon = normalizeLower(metadata.addon);
  const product = normalizeLower(metadata.product);
  const moduleName = normalizeLower(metadata.module);
  const entitlement = normalizeLower(metadata.entitlement);

  return (
    feature === "tuya" ||
    addon === "tuya" ||
    product === "tuya" ||
    moduleName === "tuya" ||
    entitlement === "tuya"
  );
}

function isTuyaFeatureByPriceId(obj: any): boolean {
  const configured = getConfiguredTuyaPriceIds();
  if (configured.length === 0) return false;

  const candidatePriceIds = getDirectCandidatePriceIds(obj);
  return candidatePriceIds.some((id) => configured.includes(id));
}

function isTuyaRelatedObject(obj: any): boolean {
  return isTuyaFeatureByMetadata(obj) || isTuyaFeatureByPriceId(obj);
}

function resolveOrgIdFromObject(obj: any): string {
  if (!obj || typeof obj !== "object") return "";

  const metadata = getMetadata(obj);

  return normalizeString(
    metadata.orgId ??
      metadata.organizationId ??
      obj.orgId ??
      obj.organizationId ??
      obj.client_reference_id
  );
}

function resolveSubscriptionStatus(obj: any): string {
  return normalizeLower(
    obj?.status ??
      obj?.subscription?.status ??
      obj?.subscription_status ??
      obj?.payment_status
  );
}

function shouldEnableFromEvent(eventType: string, obj: any): boolean | null {
  const status = resolveSubscriptionStatus(obj);

  if (eventType === "checkout.session.completed") {
    if (
      status === "paid" ||
      status === "complete" ||
      status === "active" ||
      status === "trialing"
    ) {
      return true;
    }

    if (!status) {
      return true;
    }
  }

  if (
    eventType === "customer.subscription.created" ||
    eventType === "customer.subscription.updated"
  ) {
    if (ACTIVE_SUBSCRIPTION_STATUSES.has(status)) return true;
    if (INACTIVE_SUBSCRIPTION_STATUSES.has(status)) return false;
  }

  if (eventType === "customer.subscription.deleted") {
    return false;
  }

  return null;
}

async function loadOrganization(prisma: PrismaLike, orgId: string): Promise<any | null> {
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

function buildMetadataPatch(enabled: boolean, currentMetadata: unknown) {
  const metadata = asPlainObject(currentMetadata);

  return {
    ...metadata,
    tuya: enabled,
    tuyaAddon: enabled,
    tuyaEntitlementSource: "stripe_webhook",
    tuyaEntitlementUpdatedAt: new Date().toISOString(),
  };
}

function buildOrganizationBooleanPatch(enabled: boolean, currentOrg: any): Record<string, any> {
  const patch: Record<string, any> = {};

  if ("tuyaEnabled" in (currentOrg ?? {})) patch.tuyaEnabled = enabled;
  if ("hasTuyaAddon" in (currentOrg ?? {})) patch.hasTuyaAddon = enabled;
  if ("premiumTuyaEnabled" in (currentOrg ?? {})) patch.premiumTuyaEnabled = enabled;
  if ("isTuyaEnabled" in (currentOrg ?? {})) patch.isTuyaEnabled = enabled;

  return patch;
}

async function tryOrganizationUpdate(
  prisma: PrismaLike,
  orgId: string,
  data: Record<string, any>
): Promise<boolean> {
  const db = prisma as any;
  if (!db?.organization?.update) return false;

  const keys = Object.keys(data);
  if (keys.length === 0) return false;

  try {
    await db.organization.update({
      where: { id: orgId },
      data,
    });
    return true;
  } catch {
    return false;
  }
}

async function updateOrganizationEntitlement(
  prisma: PrismaLike,
  orgId: string,
  enabled: boolean
): Promise<boolean> {
  const currentOrg = await loadOrganization(prisma, orgId);
  const booleanPatch = buildOrganizationBooleanPatch(enabled, currentOrg);
  const metadataPatch = buildMetadataPatch(enabled, currentOrg?.metadata);

  // 1) intentar bools + metadata
  const combinedPatch: Record<string, any> = {
    ...booleanPatch,
    metadata: metadataPatch,
  };

  if (await tryOrganizationUpdate(prisma, orgId, combinedPatch)) {
    return true;
  }

  // 2) intentar solo bools
  if (await tryOrganizationUpdate(prisma, orgId, booleanPatch)) {
    return true;
  }

  // 3) intentar solo metadata
  if (
    await tryOrganizationUpdate(prisma, orgId, {
      metadata: metadataPatch,
    })
  ) {
    return true;
  }

  return false;
}

async function trySubscriptionUpdateMany(
  prisma: PrismaLike,
  where: Record<string, any>,
  data: Record<string, any>
): Promise<boolean> {
  const db = prisma as any;
  if (!db?.subscription?.updateMany) return false;

  const keys = Object.keys(data);
  if (keys.length === 0) return false;

  try {
    await db.subscription.updateMany({
      where,
      data,
    });
    return true;
  } catch {
    return false;
  }
}

async function loadOneSubscriptionForOrg(
  prisma: PrismaLike,
  orgId: string
): Promise<any | null> {
  const db = prisma as any;
  if (!db?.subscription?.findFirst) return null;

  try {
    return await db.subscription.findFirst({
      where: { organizationId: orgId },
      orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
    });
  } catch {
    //
  }

  try {
    return await db.subscription.findFirst({
      where: { orgId },
      orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
    });
  } catch {
    return null;
  }
}

function buildSubscriptionBooleanPatch(enabled: boolean, currentSub: any): Record<string, any> {
  const patch: Record<string, any> = {};

  if ("tuyaEnabled" in (currentSub ?? {})) patch.tuyaEnabled = enabled;
  if ("hasTuyaAddon" in (currentSub ?? {})) patch.hasTuyaAddon = enabled;
  if ("premiumTuyaEnabled" in (currentSub ?? {})) patch.premiumTuyaEnabled = enabled;
  if ("isTuyaEnabled" in (currentSub ?? {})) patch.isTuyaEnabled = enabled;

  return patch;
}

async function tryUpdateSubscriptionEntitlement(
  prisma: PrismaLike,
  orgId: string,
  enabled: boolean
): Promise<void> {
  const currentSub = await loadOneSubscriptionForOrg(prisma, orgId);
  const booleanPatch = buildSubscriptionBooleanPatch(enabled, currentSub);
  const metadataPatch = buildMetadataPatch(enabled, currentSub?.metadata);

  const combinedPatch: Record<string, any> = {
    ...booleanPatch,
    metadata: metadataPatch,
  };

  if (
    await trySubscriptionUpdateMany(prisma, { organizationId: orgId }, combinedPatch)
  ) {
    return;
  }

  if (await trySubscriptionUpdateMany(prisma, { orgId }, combinedPatch)) {
    return;
  }

  if (
    Object.keys(booleanPatch).length > 0 &&
    (await trySubscriptionUpdateMany(prisma, { organizationId: orgId }, booleanPatch))
  ) {
    return;
  }

  if (
    Object.keys(booleanPatch).length > 0 &&
    (await trySubscriptionUpdateMany(prisma, { orgId }, booleanPatch))
  ) {
    return;
  }

  await trySubscriptionUpdateMany(
    prisma,
    { organizationId: orgId },
    { metadata: metadataPatch }
  );

  await trySubscriptionUpdateMany(
    prisma,
    { orgId },
    { metadata: metadataPatch }
  );
}

export async function syncTuyaEntitlementFromStripeEvent(
  prisma: PrismaLike,
  event: StripeEventLike
): Promise<TuyaEntitlementSyncResult> {
  if (!event || typeof event !== "object") {
    return {
      handled: false,
      matched: false,
      orgId: null,
      enabled: null,
      reason: "missing_event",
    };
  }

  const eventType = normalizeString(event.type);
  const supported =
    eventType === "checkout.session.completed" ||
    eventType === "customer.subscription.created" ||
    eventType === "customer.subscription.updated" ||
    eventType === "customer.subscription.deleted";

  if (!supported) {
    return {
      handled: false,
      matched: false,
      orgId: null,
      enabled: null,
      reason: "unsupported_event",
    };
  }

  const obj = getEventObject(event);
  if (!obj) {
    return {
      handled: true,
      matched: false,
      orgId: null,
      enabled: null,
      reason: "missing_object",
    };
  }

  if (!isTuyaRelatedObject(obj)) {
    return {
      handled: true,
      matched: false,
      orgId: null,
      enabled: null,
      reason: "not_tuya",
    };
  }

  const orgId = resolveOrgIdFromObject(obj);
  if (!orgId) {
    return {
      handled: true,
      matched: true,
      orgId: null,
      enabled: null,
      reason: "missing_org",
    };
  }

  const enabled = shouldEnableFromEvent(eventType, obj);
  if (enabled === null) {
    return {
      handled: true,
      matched: true,
      orgId,
      enabled: null,
      reason: "noop",
    };
  }

  const orgUpdated = await updateOrganizationEntitlement(prisma, orgId, enabled);
  await tryUpdateSubscriptionEntitlement(prisma, orgId, enabled);

  return {
    handled: true,
    matched: true,
    orgId,
    enabled,
    reason: enabled
      ? orgUpdated
        ? "enabled"
        : "noop"
      : orgUpdated
      ? "disabled"
      : "noop",
  };
}

export default syncTuyaEntitlementFromStripeEvent;