import {
  normalizePropertyKnowledgeEntryDraft,
  type PropertyKnowledgeEntryCategory,
  type PropertyKnowledgeEntryVisibility,
} from "./property-knowledge-entry.contract.js";

export type PropertyKnowledgeLanguage = "en" | "es";

export type PropertyKnowledgeFact = Readonly<{
  category:
    | "ARRIVAL"
    | "ACCESS"
    | "AMENITIES"
    | "HOUSE_RULES"
    | "CANCELLATION"
    | "PROPERTY"
    | "WIFI"
    | "PARKING"
    | "APPLIANCE"
    | "TROUBLESHOOTING"
    | "EMERGENCY"
    | "LOCAL_GUIDE";
  key: string;
  value: unknown;
  source:
    | "PROPERTY"
    | "AMENITY"
    | "LOCK"
    | "PROPERTY_DEVICE"
    | "GUEST_AGREEMENT"
    | "CANCELLATION_POLICY"
    | "PROPERTY_GUEST_KNOWLEDGE";
  authoritative: true;
}>;

export type PropertyKnowledgeSnapshot = Readonly<{
  organizationId: string;
  propertyId: string;
  language: PropertyKnowledgeLanguage;
  facts: readonly PropertyKnowledgeFact[];
}>;

type PropertyKnowledgeRecord = Readonly<{
  id: string;
  organizationId: string;
  name: string;
  publicTitle: string | null;
  publicDescription: string | null;
  publicDescriptionEs: string | null;
  maxGuests: number | null;
  timezone: string | null;
  checkInTime: string | null;
  checkOutTime: string | null;
  guestAccessMode: string;
  amenities: readonly Readonly<{
    name: string;
    description: string | null;
    chargeMode: string;
  }>[];
  locks: readonly Readonly<{
    displayName: string | null;
    locationLabel: string | null;
    ttlockLockName: string | null;
  }>[];
  propertyDevices: readonly Readonly<{
    name: string;
    type: string;
    provider: string;
  }>[];
  guestAgreements: readonly Readonly<{
    version: string;
    title: string;
    titleEn: string | null;
    titleEs: string | null;
    guestFacingSummary: string | null;
    guestFacingSummaryEn: string | null;
    guestFacingSummaryEs: string | null;
    rules: unknown;
    rulesEn: unknown;
    rulesEs: unknown;
  }>[];
  cancellationPolicies: readonly Readonly<{
    name: string;
    guestFacingSummary: string | null;
    description: string | null;
    refundRules: unknown;
    nonRefundableScenarios: unknown;
  }>[];
  knowledgeEntries?: readonly Readonly<{
    category: PropertyKnowledgeEntryCategory;
    key: string;
    titleEn: string | null;
    titleEs: string | null;
    contentEn: string | null;
    contentEs: string | null;
    visibility: PropertyKnowledgeEntryVisibility;
    sortOrder: number;
    revision: number;
    isActive: boolean;
  }>[];
  reservations?: readonly Readonly<{
    id: string;
    status: string;
    checkIn: Date;
    checkOut: Date;
  }>[];
}>;

type PropertyKnowledgePrisma = Readonly<{
  property: Readonly<{
    findFirst(args: unknown): Promise<PropertyKnowledgeRecord | null>;
  }>;
}>;

const PROHIBITED_KEYS = new Set([
  "activePasscode",
  "futurePasscode",
  "nfcCredential",
  "ttlockLockId",
  "externalId",
  "stripeSecret",
  "paymentMethod",
  "identityDocument",
  "governmentId",
  "refundAuthorization",
]);

export async function getPropertyKnowledgeSnapshot({
  prisma,
  organizationId,
  propertyId,
  reservationId,
  currentDateTime,
  language = "en",
}: {
  prisma: PropertyKnowledgePrisma;
  organizationId: string;
  propertyId: string;
  reservationId?: string;
  currentDateTime?: string;
  language?: PropertyKnowledgeLanguage;
}): Promise<PropertyKnowledgeSnapshot> {
  const property = await loadPropertyKnowledgeRecord({
    prisma,
    organizationId,
    propertyId,
    reservationId,
  });

  if (!property) {
    throw new Error("PROPERTY_KNOWLEDGE_PROPERTY_NOT_FOUND");
  }

  const snapshot = composePropertyKnowledgeSnapshot({
    organizationId,
    propertyId,
    language,
    currentDateTime,
    property,
  });

  assertNoProhibitedKnowledge(snapshot);
  return snapshot;
}

async function loadPropertyKnowledgeRecord({
  prisma,
  organizationId,
  propertyId,
  reservationId,
}: {
  prisma: PropertyKnowledgePrisma;
  organizationId: string;
  propertyId: string;
  reservationId?: string;
}) {
  return prisma.property.findFirst({
    where: {
      id: propertyId,
      organizationId,
      status: "ACTIVE",
    },
    select: {
      id: true,
      organizationId: true,
      name: true,
      publicTitle: true,
      publicDescription: true,
      publicDescriptionEs: true,
      maxGuests: true,
      timezone: true,
      checkInTime: true,
      checkOutTime: true,
      guestAccessMode: true,
      amenities: {
        where: { isActive: true },
        orderBy: { createdAt: "asc" },
        select: {
          name: true,
          description: true,
          chargeMode: true,
        },
      },
      locks: {
        where: { isActive: true },
        orderBy: { createdAt: "asc" },
        select: {
          displayName: true,
          locationLabel: true,
          ttlockLockName: true,
        },
      },
      propertyDevices: {
        where: { isActive: true },
        orderBy: { createdAt: "asc" },
        select: {
          name: true,
          type: true,
          provider: true,
        },
      },
      guestAgreements: {
        where: { isActive: true },
        orderBy: { updatedAt: "desc" },
        take: 1,
        select: {
          version: true,
          title: true,
          titleEn: true,
          titleEs: true,
          guestFacingSummary: true,
          guestFacingSummaryEn: true,
          guestFacingSummaryEs: true,
          rules: true,
          rulesEn: true,
          rulesEs: true,
        },
      },
      cancellationPolicies: {
        where: { isActive: true },
        orderBy: { updatedAt: "desc" },
        take: 1,
        select: {
          name: true,
          guestFacingSummary: true,
          description: true,
          refundRules: true,
          nonRefundableScenarios: true,
        },
      },
      knowledgeEntries: {
        where: { isActive: true },
        orderBy: [
          { category: "asc" },
          { sortOrder: "asc" },
          { key: "asc" },
        ],
        select: {
          category: true,
          key: true,
          titleEn: true,
          titleEs: true,
          contentEn: true,
          contentEs: true,
          visibility: true,
          sortOrder: true,
          revision: true,
          isActive: true,
        },
      },
      ...(reservationId
        ? {
            reservations: {
              where: {
                id: reservationId,
                status: "ACTIVE",
              },
              take: 1,
              select: {
                id: true,
                status: true,
                checkIn: true,
                checkOut: true,
              },
            },
          }
        : {}),
    },
  });
}

export function composePropertyKnowledgeSnapshot({
  organizationId,
  propertyId,
  language,
  currentDateTime,
  property,
}: {
  organizationId: string;
  propertyId: string;
  language: PropertyKnowledgeLanguage;
  currentDateTime?: string;
  property: NonNullable<PropertyKnowledgeRecord>;
}): PropertyKnowledgeSnapshot {
  const facts: PropertyKnowledgeFact[] = [];

  addFact(facts, "PROPERTY", "name", property.publicTitle ?? property.name, "PROPERTY");
  addFact(
    facts,
    "PROPERTY",
    "description",
    language === "es"
      ? property.publicDescriptionEs ?? property.publicDescription
      : property.publicDescription ?? property.publicDescriptionEs,
    "PROPERTY",
  );
  addFact(facts, "PROPERTY", "timezone", property.timezone, "PROPERTY");
  addFact(facts, "PROPERTY", "maxGuests", property.maxGuests, "PROPERTY");
  addFact(facts, "ARRIVAL", "checkInTime", property.checkInTime, "PROPERTY");
  addFact(facts, "ARRIVAL", "checkOutTime", property.checkOutTime, "PROPERTY");
  addFact(facts, "ACCESS", "guestAccessMode", property.guestAccessMode, "PROPERTY");

  if (property.amenities.length > 0) {
    addFact(
      facts,
      "AMENITIES",
      "amenities",
      property.amenities.map((amenity) => ({
        name: amenity.name,
        description: amenity.description,
        chargeMode: amenity.chargeMode,
      })),
      "AMENITY",
    );
  }

  if (property.locks.length > 0) {
    addFact(
      facts,
      "ACCESS",
      "locks",
      property.locks.map((lock) => ({
        displayName: lock.displayName ?? lock.ttlockLockName ?? "Lock",
        locationLabel: lock.locationLabel,
      })),
      "LOCK",
    );
  }

  if (property.propertyDevices.length > 0) {
    addFact(
      facts,
      "PROPERTY",
      "devices",
      property.propertyDevices.map((device) => ({
        name: device.name,
        type: device.type,
        provider: device.provider,
      })),
      "PROPERTY_DEVICE",
    );
  }

  const agreement = property.guestAgreements[0];
  if (agreement) {
    addFact(
      facts,
      "HOUSE_RULES",
      "agreementVersion",
      agreement.version,
      "GUEST_AGREEMENT",
    );
    addFact(
      facts,
      "HOUSE_RULES",
      "agreementTitle",
      language === "es"
        ? agreement.titleEs ?? agreement.title ?? agreement.titleEn
        : agreement.titleEn ?? agreement.title ?? agreement.titleEs,
      "GUEST_AGREEMENT",
    );
    addFact(
      facts,
      "HOUSE_RULES",
      "guestFacingSummary",
      language === "es"
        ? agreement.guestFacingSummaryEs ??
            agreement.guestFacingSummary ??
            agreement.guestFacingSummaryEn
        : agreement.guestFacingSummaryEn ??
            agreement.guestFacingSummary ??
            agreement.guestFacingSummaryEs,
      "GUEST_AGREEMENT",
    );
    addFact(
      facts,
      "HOUSE_RULES",
      "rules",
      language === "es"
        ? agreement.rulesEs ?? agreement.rules ?? agreement.rulesEn
        : agreement.rulesEn ?? agreement.rules ?? agreement.rulesEs,
      "GUEST_AGREEMENT",
    );
  }

  const cancellationPolicy = property.cancellationPolicies[0];
  if (cancellationPolicy) {
    addFact(
      facts,
      "CANCELLATION",
      "policyName",
      cancellationPolicy.name,
      "CANCELLATION_POLICY",
    );
    addFact(
      facts,
      "CANCELLATION",
      "guestFacingSummary",
      cancellationPolicy.guestFacingSummary ?? cancellationPolicy.description,
      "CANCELLATION_POLICY",
    );
    addFact(
      facts,
      "CANCELLATION",
      "refundRules",
      cancellationPolicy.refundRules,
      "CANCELLATION_POLICY",
    );
    addFact(
      facts,
      "CANCELLATION",
      "nonRefundableScenarios",
      cancellationPolicy.nonRefundableScenarios,
      "CANCELLATION_POLICY",
    );
  }

  addPersistedKnowledgeEntries({
    facts,
    language,
    currentDateTime,
    property,
  });

  return {
    organizationId,
    propertyId,
    language,
    facts,
  };
}

function addPersistedKnowledgeEntries({
  facts,
  language,
  currentDateTime,
  property,
}: {
  facts: PropertyKnowledgeFact[];
  language: PropertyKnowledgeLanguage;
  currentDateTime?: string;
  property: NonNullable<PropertyKnowledgeRecord>;
}): void {
  const reservation = property.reservations?.[0];
  const confirmedGuest = reservation?.status === "ACTIVE";
  const current = currentDateTime ? new Date(currentDateTime) : null;
  const duringStay = Boolean(
    reservation &&
      confirmedGuest &&
      current &&
      Number.isFinite(current.getTime()) &&
      current >= reservation.checkIn &&
      current < reservation.checkOut,
  );

  for (const entry of property.knowledgeEntries ?? []) {
    if (!entry.isActive) continue;
    if (entry.visibility === "CONFIRMED_GUEST" && !confirmedGuest) {
      continue;
    }
    if (entry.visibility === "DURING_STAY" && !duringStay) continue;

    const normalized = normalizePropertyKnowledgeEntryDraft(entry);
    const title =
      language === "es"
        ? normalized.titleEs ?? normalized.titleEn
        : normalized.titleEn ?? normalized.titleEs;
    const content =
      language === "es"
        ? normalized.contentEs ?? normalized.contentEn
        : normalized.contentEn ?? normalized.contentEs;

    addFact(
      facts,
      normalized.category,
      normalized.key,
      { title, content },
      "PROPERTY_GUEST_KNOWLEDGE",
    );
  }
}

function addFact(
  facts: PropertyKnowledgeFact[],
  category: PropertyKnowledgeFact["category"],
  key: string,
  value: unknown,
  source: PropertyKnowledgeFact["source"],
): void {
  if (value === null || value === undefined || value === "") return;

  facts.push({
    category,
    key,
    value,
    source,
    authoritative: true,
  });
}

function assertNoProhibitedKnowledge(value: unknown, path: string[] = []): void {
  if (!value || typeof value !== "object") return;

  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      assertNoProhibitedKnowledge(item, [...path, String(index)]),
    );
    return;
  }

  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (PROHIBITED_KEYS.has(key)) {
      throw new Error(
        `PROPERTY_KNOWLEDGE_PROHIBITED_FIELD:${[...path, key].join(".")}`,
      );
    }

    assertNoProhibitedKnowledge(nested, [...path, key]);
  }
}
