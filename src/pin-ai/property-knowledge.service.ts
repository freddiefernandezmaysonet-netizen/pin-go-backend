export type PropertyKnowledgeLanguage = "en" | "es";

export type PropertyKnowledgeFact = Readonly<{
  category:
    | "ARRIVAL"
    | "WIFI"
    | "ACCESS"
    | "PARKING"
    | "AMENITIES"
    | "APPLIANCES"
    | "UTILITIES"
    | "HOUSE_RULES"
    | "CHECKOUT"
    | "SAFETY"
    | "LOCAL_INFO"
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
  guestKnowledge: Readonly<{
    version: number;
    wifi: unknown;
    parking: unknown;
    arrivalInstructionsEn: string | null;
    arrivalInstructionsEs: string | null;
    accessInstructionsEn: string | null;
    accessInstructionsEs: string | null;
    applianceGuides: unknown;
    troubleshooting: unknown;
    utilities: unknown;
    garbageInstructionsEn: string | null;
    garbageInstructionsEs: string | null;
    checkoutInstructionsEn: string | null;
    checkoutInstructionsEs: string | null;
    safetyInformation: unknown;
    localNotes: unknown;
    customFaq: unknown;
  }> | null;
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
  language = "en",
}: {
  prisma: PropertyKnowledgePrisma;
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
  prisma: PropertyKnowledgePrisma;
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
      guestKnowledge: {
        select: {
          version: true,
          wifi: true,
          parking: true,
          arrivalInstructionsEn: true,
          arrivalInstructionsEs: true,
          accessInstructionsEn: true,
          accessInstructionsEs: true,
          applianceGuides: true,
          troubleshooting: true,
          utilities: true,
          garbageInstructionsEn: true,
          garbageInstructionsEs: true,
          checkoutInstructionsEn: true,
          checkoutInstructionsEs: true,
          safetyInformation: true,
          localNotes: true,
          customFaq: true,
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

  const guestKnowledge = property.guestKnowledge;
  if (guestKnowledge) {
    addFact(
      facts,
      "PROPERTY",
      "guestKnowledgeVersion",
      guestKnowledge.version,
      "PROPERTY_GUEST_KNOWLEDGE",
    );
    addFact(
      facts,
      "WIFI",
      "wifi",
      guestKnowledge.wifi,
      "PROPERTY_GUEST_KNOWLEDGE",
    );
    addFact(
      facts,
      "PARKING",
      "parking",
      guestKnowledge.parking,
      "PROPERTY_GUEST_KNOWLEDGE",
    );
    addFact(
      facts,
      "ARRIVAL",
      "arrivalInstructions",
      language === "es"
        ? guestKnowledge.arrivalInstructionsEs ?? guestKnowledge.arrivalInstructionsEn
        : guestKnowledge.arrivalInstructionsEn ?? guestKnowledge.arrivalInstructionsEs,
      "PROPERTY_GUEST_KNOWLEDGE",
    );
    addFact(
      facts,
      "ACCESS",
      "accessInstructions",
      language === "es"
        ? guestKnowledge.accessInstructionsEs ?? guestKnowledge.accessInstructionsEn
        : guestKnowledge.accessInstructionsEn ?? guestKnowledge.accessInstructionsEs,
      "PROPERTY_GUEST_KNOWLEDGE",
    );
    addFact(
      facts,
      "APPLIANCES",
      "applianceGuides",
      guestKnowledge.applianceGuides,
      "PROPERTY_GUEST_KNOWLEDGE",
    );
    addFact(
      facts,
      "PROPERTY",
      "troubleshooting",
      guestKnowledge.troubleshooting,
      "PROPERTY_GUEST_KNOWLEDGE",
    );
    addFact(
      facts,
      "UTILITIES",
      "utilities",
      guestKnowledge.utilities,
      "PROPERTY_GUEST_KNOWLEDGE",
    );
    addFact(
      facts,
      "UTILITIES",
      "garbageInstructions",
      language === "es"
        ? guestKnowledge.garbageInstructionsEs ?? guestKnowledge.garbageInstructionsEn
        : guestKnowledge.garbageInstructionsEn ?? guestKnowledge.garbageInstructionsEs,
      "PROPERTY_GUEST_KNOWLEDGE",
    );
    addFact(
      facts,
      "CHECKOUT",
      "checkoutInstructions",
      language === "es"
        ? guestKnowledge.checkoutInstructionsEs ?? guestKnowledge.checkoutInstructionsEn
        : guestKnowledge.checkoutInstructionsEn ?? guestKnowledge.checkoutInstructionsEs,
      "PROPERTY_GUEST_KNOWLEDGE",
    );
    addFact(
      facts,
      "SAFETY",
      "safetyInformation",
      guestKnowledge.safetyInformation,
      "PROPERTY_GUEST_KNOWLEDGE",
    );
    addFact(
      facts,
      "LOCAL_INFO",
      "localNotes",
      guestKnowledge.localNotes,
      "PROPERTY_GUEST_KNOWLEDGE",
    );
    addFact(
      facts,
      "LOCAL_INFO",
      "customFaq",
      guestKnowledge.customFaq,
      "PROPERTY_GUEST_KNOWLEDGE",
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
