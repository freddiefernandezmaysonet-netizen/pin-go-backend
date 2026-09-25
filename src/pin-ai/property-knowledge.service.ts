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
    | "LOCAL_GUIDE"
    | "PRICING";
  key: string;
  value: unknown;
  source:
    | "PROPERTY"
    | "AMENITY"
    | "LOCK"
    | "PROPERTY_DEVICE"
    | "GUEST_AGREEMENT"
    | "CANCELLATION_POLICY"
    | "PROPERTY_LISTING_DETAILS"
    | "PROPERTY_TAX"
    | "PROPERTY_REVIEW"
    | "PROPERTY_GUEST_KNOWLEDGE";
  authoritative: true;
}>;

export type PropertyKnowledgeSnapshot = Readonly<{
  organizationId: string;
  propertyId: string;
  language: PropertyKnowledgeLanguage;
  facts: readonly PropertyKnowledgeFact[];
}>;

type PropertyKnowledgeReviewSummary = Readonly<{
  averageRating: number | null;
  reviewCount: number;
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
    feeType: string;
    amount: unknown;
  }>[];
  taxes?: readonly Readonly<{
    name: string;
    percentage: unknown;
  }>[];
  listingDetails?: Readonly<{
    version: number;
    accommodationType: string | null;
    bedroomCount: number | null;
    fullBathroomCount: number | null;
    halfBathroomCount: number | null;
    minimumPrimaryBookingGuestAge: number | null;
    childrenPolicy: string;
    infantsPolicy: string;
    adultsOnly: string;
    petsPolicy: string;
    smokingPolicy: string;
    vapingPolicy: string;
    eventsPolicy: string;
    unregisteredVisitorsPolicy: string;
    quietHoursEnabled: string;
    quietHoursStart: string | null;
    quietHoursEnd: string | null;
    parkingAvailability: string;
    parkingType: string | null;
    parkingFeeType: string | null;
    parkingVehicleCapacity: number | null;
    smokeDetector: string;
    carbonMonoxideDetector: string;
    exteriorSecurityCameras: string;
    exteriorSecurityCamerasDisclosureEn: string | null;
    exteriorSecurityCamerasDisclosureEs: string | null;
    animalsOnProperty: string;
    animalsOnPropertyDisclosureEn: string | null;
    animalsOnPropertyDisclosureEs: string | null;
    stepFreeEntrance: string;
    entranceStepCount: number | null;
    elevatorAvailable: string;
    accessibleParking: string;
    stepFreeBedroomAccess: string;
    stepFreeBathroomAccess: string;
    stepFreeShower: string;
    sleepingAreas: readonly Readonly<{
      kind: string;
      nameEn: string | null;
      nameEs: string | null;
      sortOrder: number;
      beds: readonly Readonly<{
        type: string;
        quantity: number;
      }>[];
    }>[];
    sharedSpaces: readonly Readonly<{
      type: string;
      labelEn: string | null;
      labelEs: string | null;
      sortOrder: number;
    }>[];
    safetyConsiderations: readonly Readonly<{
      type: string;
      descriptionEn: string | null;
      descriptionEs: string | null;
      sortOrder: number;
    }>[];
    additionalConsiderations: readonly Readonly<{
      titleEn: string | null;
      titleEs: string | null;
      descriptionEn: string | null;
      descriptionEs: string | null;
      sortOrder: number;
    }>[];
  }> | null;
  reviewSummary?: PropertyKnowledgeReviewSummary;
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
  propertyReview: Readonly<{
    aggregate(args: unknown): Promise<{
      _avg: Readonly<{ overallRating: number | null }>;
      _count: Readonly<{ _all: number }>;
    }>;
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

  const reviewSummary = await loadPropertyReviewSummary({
    prisma,
    organizationId,
    propertyId,
  });
  const snapshot = composePropertyKnowledgeSnapshot({
    organizationId,
    propertyId,
    language,
    currentDateTime,
    property: { ...property, reviewSummary },
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
          feeType: true,
          amount: true,
        },
      },
      taxes: {
        where: { isActive: true },
        orderBy: { name: "asc" },
        select: {
          name: true,
          percentage: true,
        },
      },
      listingDetails: {
        select: {
          version: true,
          accommodationType: true,
          bedroomCount: true,
          fullBathroomCount: true,
          halfBathroomCount: true,
          minimumPrimaryBookingGuestAge: true,
          childrenPolicy: true,
          infantsPolicy: true,
          adultsOnly: true,
          petsPolicy: true,
          smokingPolicy: true,
          vapingPolicy: true,
          eventsPolicy: true,
          unregisteredVisitorsPolicy: true,
          quietHoursEnabled: true,
          quietHoursStart: true,
          quietHoursEnd: true,
          parkingAvailability: true,
          parkingType: true,
          parkingFeeType: true,
          parkingVehicleCapacity: true,
          smokeDetector: true,
          carbonMonoxideDetector: true,
          exteriorSecurityCameras: true,
          exteriorSecurityCamerasDisclosureEn: true,
          exteriorSecurityCamerasDisclosureEs: true,
          animalsOnProperty: true,
          animalsOnPropertyDisclosureEn: true,
          animalsOnPropertyDisclosureEs: true,
          stepFreeEntrance: true,
          entranceStepCount: true,
          elevatorAvailable: true,
          accessibleParking: true,
          stepFreeBedroomAccess: true,
          stepFreeBathroomAccess: true,
          stepFreeShower: true,
          sleepingAreas: {
            orderBy: { sortOrder: "asc" },
            select: {
              kind: true,
              nameEn: true,
              nameEs: true,
              sortOrder: true,
              beds: {
                orderBy: { createdAt: "asc" },
                select: {
                  type: true,
                  quantity: true,
                },
              },
            },
          },
          sharedSpaces: {
            orderBy: { sortOrder: "asc" },
            select: {
              type: true,
              labelEn: true,
              labelEs: true,
              sortOrder: true,
            },
          },
          safetyConsiderations: {
            where: { isActive: true },
            orderBy: { sortOrder: "asc" },
            select: {
              type: true,
              descriptionEn: true,
              descriptionEs: true,
              sortOrder: true,
            },
          },
          additionalConsiderations: {
            where: { isActive: true },
            orderBy: { sortOrder: "asc" },
            select: {
              titleEn: true,
              titleEs: true,
              descriptionEn: true,
              descriptionEs: true,
              sortOrder: true,
            },
          },
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

async function loadPropertyReviewSummary({
  prisma,
  organizationId,
  propertyId,
}: {
  prisma: PropertyKnowledgePrisma;
  organizationId: string;
  propertyId: string;
}): Promise<PropertyKnowledgeReviewSummary> {
  const result = await prisma.propertyReview.aggregate({
    where: {
      organizationId,
      propertyId,
      status: "PUBLISHED",
      source: "PIN_GO_DIRECT",
    },
    _avg: { overallRating: true },
    _count: { _all: true },
  });

  return {
    averageRating:
      result._avg.overallRating === null
        ? null
        : Math.round(result._avg.overallRating * 100) / 100,
    reviewCount: result._count._all,
  };
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
        feeType: amenity.feeType,
        amount: toGuestNumber(amenity.amount),
      })),
      "AMENITY",
    );
  }

  if ((property.taxes?.length ?? 0) > 0) {
    addFact(
      facts,
      "PRICING",
      "taxes",
      property.taxes?.map((tax) => ({
        name: tax.name,
        percentage: toGuestNumber(tax.percentage),
      })),
      "PROPERTY_TAX",
    );
  }

  if (property.listingDetails) {
    addListingDetailsFacts(facts, property.listingDetails, language);
  }

  addReviewSummaryFact(
    facts,
    property.reviewSummary ?? { averageRating: null, reviewCount: 0 },
  );

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

function addReviewSummaryFact(
  facts: PropertyKnowledgeFact[],
  summary: PropertyKnowledgeReviewSummary,
): void {
  addFact(
    facts,
    "PROPERTY",
    "reviewSummary",
    {
      averageRating: summary.averageRating,
      reviewCount: summary.reviewCount,
      scale: 5,
      source: "PIN_GO_DIRECT",
    },
    "PROPERTY_REVIEW",
  );
}

function addListingDetailsFacts(
  facts: PropertyKnowledgeFact[],
  details: NonNullable<PropertyKnowledgeRecord["listingDetails"]>,
  language: PropertyKnowledgeLanguage,
): void {
  const localized = (
    english: string | null,
    spanish: string | null,
  ): string | null =>
    language === "es" ? spanish ?? english : english ?? spanish;

  const sleepingAreas = details.sleepingAreas.map((area) => ({
    kind: area.kind,
    name: localized(area.nameEn, area.nameEs),
    beds: area.beds.map((bed) => ({
      type: bed.type,
      quantity: bed.quantity,
    })),
  }));
  const bedTypeCounts: Record<string, number> = {};
  let totalBeds = 0;
  for (const area of sleepingAreas) {
    for (const bed of area.beds) {
      const quantity = Number.isInteger(bed.quantity) && bed.quantity > 0
        ? bed.quantity
        : 0;
      totalBeds += quantity;
      bedTypeCounts[bed.type] = (bedTypeCounts[bed.type] ?? 0) + quantity;
    }
  }

  addFact(
    facts,
    "PROPERTY",
    "listingSummary",
    {
      version: details.version,
      accommodationType: details.accommodationType,
      bedroomCount: details.bedroomCount,
      fullBathroomCount: details.fullBathroomCount,
      halfBathroomCount: details.halfBathroomCount,
      minimumPrimaryBookingGuestAge: details.minimumPrimaryBookingGuestAge,
      totalBeds,
      bedTypeCounts,
    },
    "PROPERTY_LISTING_DETAILS",
  );
  addFact(
    facts,
    "PROPERTY",
    "sleepingAreas",
    sleepingAreas,
    "PROPERTY_LISTING_DETAILS",
  );
  addFact(
    facts,
    "HOUSE_RULES",
    "listingPolicies",
    {
      childrenPolicy: details.childrenPolicy,
      infantsPolicy: details.infantsPolicy,
      adultsOnly: details.adultsOnly,
      petsPolicy: details.petsPolicy,
      smokingPolicy: details.smokingPolicy,
      vapingPolicy: details.vapingPolicy,
      eventsPolicy: details.eventsPolicy,
      unregisteredVisitorsPolicy: details.unregisteredVisitorsPolicy,
      quietHoursEnabled: details.quietHoursEnabled,
      quietHoursStart: details.quietHoursStart,
      quietHoursEnd: details.quietHoursEnd,
    },
    "PROPERTY_LISTING_DETAILS",
  );
  addFact(
    facts,
    "PARKING",
    "parking",
    {
      availability: details.parkingAvailability,
      type: details.parkingType,
      feeType: details.parkingFeeType,
      vehicleCapacity: details.parkingVehicleCapacity,
    },
    "PROPERTY_LISTING_DETAILS",
  );
  addFact(
    facts,
    "PROPERTY",
    "safetyAndAccessibility",
    {
      smokeDetector: details.smokeDetector,
      carbonMonoxideDetector: details.carbonMonoxideDetector,
      exteriorSecurityCameras: details.exteriorSecurityCameras,
      exteriorSecurityCamerasDisclosure: localized(
        details.exteriorSecurityCamerasDisclosureEn,
        details.exteriorSecurityCamerasDisclosureEs,
      ),
      animalsOnProperty: details.animalsOnProperty,
      animalsOnPropertyDisclosure: localized(
        details.animalsOnPropertyDisclosureEn,
        details.animalsOnPropertyDisclosureEs,
      ),
      stepFreeEntrance: details.stepFreeEntrance,
      entranceStepCount: details.entranceStepCount,
      elevatorAvailable: details.elevatorAvailable,
      accessibleParking: details.accessibleParking,
      stepFreeBedroomAccess: details.stepFreeBedroomAccess,
      stepFreeBathroomAccess: details.stepFreeBathroomAccess,
      stepFreeShower: details.stepFreeShower,
    },
    "PROPERTY_LISTING_DETAILS",
  );
  if (details.sharedSpaces.length > 0) {
    addFact(
      facts,
      "PROPERTY",
      "sharedSpaces",
      details.sharedSpaces.map((space) => ({
        type: space.type,
        label: localized(space.labelEn, space.labelEs),
      })),
      "PROPERTY_LISTING_DETAILS",
    );
  }
  if (details.safetyConsiderations.length > 0) {
    addFact(
      facts,
      "PROPERTY",
      "safetyConsiderations",
      details.safetyConsiderations.map((item) => ({
        type: item.type,
        description: localized(item.descriptionEn, item.descriptionEs),
      })),
      "PROPERTY_LISTING_DETAILS",
    );
  }
  if (details.additionalConsiderations.length > 0) {
    addFact(
      facts,
      "PROPERTY",
      "additionalConsiderations",
      details.additionalConsiderations.map((item) => ({
        title: localized(item.titleEn, item.titleEs),
        description: localized(item.descriptionEn, item.descriptionEs),
      })),
      "PROPERTY_LISTING_DETAILS",
    );
  }
}

function toGuestNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
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
