import type { PrismaClient } from "@prisma/client";

export type PropertyKnowledgeLanguage = "en" | "es";

export type PropertyKnowledgeFact = Readonly<{
  category:
    | "ARRIVAL"
    | "ACCESS"
    | "AMENITIES"
    | "HOUSE_RULES"
    | "CANCELLATION"
    | "PROPERTY";
  key: string;
  value: unknown;
  source:
    | "PROPERTY"
    | "AMENITY"
    | "LOCK"
    | "PROPERTY_DEVICE"
    | "GUEST_AGREEMENT"
    | "CANCELLATION_POLICY";
  authoritative: true;
}>;

export type PropertyKnowledgeSnapshot = Readonly<{
  organizationId: string;
  propertyId: string;
  language: PropertyKnowledgeLanguage;
  facts: readonly PropertyKnowledgeFact[];
}>;

type PropertyKnowledgeRecord = Awaited<
  ReturnType<typeof loadPropertyKnowledgeRecord>
>;

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
  language = "en",
}: {
  prisma: PrismaClient;
  organizationId: string;
  propertyId: string;
  language?: PropertyKnowledgeLanguage;
}): Promise<PropertyKnowledgeSnapshot> {
  const property = await loadPropertyKnowledgeRecord({
    prisma,
    organizationId,
    propertyId,
  });

  if (!property) {
    throw new Error("PROPERTY_KNOWLEDGE_PROPERTY_NOT_FOUND");
  }

  const snapshot = composePropertyKnowledgeSnapshot({
    organizationId,
    propertyId,
    language,
    property,
  });

  assertNoProhibitedKnowledge(snapshot);
  return snapshot;
}

async function loadPropertyKnowledgeRecord({
  prisma,
  organizationId,
  propertyId,
}: {
  prisma: PrismaClient;
  organizationId: string;
  propertyId: string;
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
    },
  });
}

export function composePropertyKnowledgeSnapshot({
  organizationId,
  propertyId,
  language,
  property,
}: {
  organizationId: string;
  propertyId: string;
  language: PropertyKnowledgeLanguage;
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

  return {
    organizationId,
    propertyId,
    language,
    facts,
  };
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
