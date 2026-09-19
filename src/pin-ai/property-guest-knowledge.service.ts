const PROHIBITED_PROPERTY_KNOWLEDGE_KEYS = new Set([
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

const TEXT_LIMIT = 4000;
const JSON_LIMIT = 16000;

type JsonObject = Readonly<Record<string, unknown>>;

export type PropertyGuestKnowledgeInput = Readonly<{
  wifi?: JsonObject | null;
  parking?: JsonObject | null;
  arrivalInstructionsEn?: string | null;
  arrivalInstructionsEs?: string | null;
  accessInstructionsEn?: string | null;
  accessInstructionsEs?: string | null;
  applianceGuides?: JsonObject | null;
  troubleshooting?: JsonObject | null;
  utilities?: JsonObject | null;
  garbageInstructionsEn?: string | null;
  garbageInstructionsEs?: string | null;
  checkoutInstructionsEn?: string | null;
  checkoutInstructionsEs?: string | null;
  safetyInformation?: JsonObject | null;
  localNotes?: readonly unknown[] | null;
  customFaq?: JsonObject | null;
}>;

type PropertyGuestKnowledgePrisma = Readonly<{
  property: Readonly<{
    findFirst(args: unknown): Promise<{ id: string } | null>;
  }>;
  propertyGuestKnowledge: Readonly<{
    findUnique(args: unknown): Promise<unknown | null>;
    upsert(args: unknown): Promise<unknown>;
  }>;
}>;

export async function getEditablePropertyGuestKnowledge({
  prisma,
  organizationId,
  propertyId,
}: {
  prisma: PropertyGuestKnowledgePrisma;
  organizationId: string;
  propertyId: string;
}) {
  await assertPropertyInOrganization({ prisma, organizationId, propertyId });

  return prisma.propertyGuestKnowledge.findUnique({
    where: { propertyId },
  });
}

export async function upsertPropertyGuestKnowledge({
  prisma,
  organizationId,
  propertyId,
  input,
}: {
  prisma: PropertyGuestKnowledgePrisma;
  organizationId: string;
  propertyId: string;
  input: PropertyGuestKnowledgeInput;
}) {
  await assertPropertyInOrganization({ prisma, organizationId, propertyId });
  const data = normalizePropertyGuestKnowledgeInput(input);

  return prisma.propertyGuestKnowledge.upsert({
    where: { propertyId },
    create: {
      propertyId,
      version: 1,
      ...data,
    },
    update: {
      ...data,
      version: { increment: 1 },
    },
  });
}

export function normalizePropertyGuestKnowledgeInput(
  input: PropertyGuestKnowledgeInput,
): Record<string, unknown> {
  assertNoOperationalSecrets(input);

  return compactUndefined({
    wifi: normalizeObject(input.wifi, "wifi"),
    parking: normalizeObject(input.parking, "parking"),
    arrivalInstructionsEn: normalizeText(
      input.arrivalInstructionsEn,
      "arrivalInstructionsEn",
    ),
    arrivalInstructionsEs: normalizeText(
      input.arrivalInstructionsEs,
      "arrivalInstructionsEs",
    ),
    accessInstructionsEn: normalizeText(
      input.accessInstructionsEn,
      "accessInstructionsEn",
    ),
    accessInstructionsEs: normalizeText(
      input.accessInstructionsEs,
      "accessInstructionsEs",
    ),
    applianceGuides: normalizeObject(input.applianceGuides, "applianceGuides"),
    troubleshooting: normalizeObject(
      input.troubleshooting,
      "troubleshooting",
    ),
    utilities: normalizeObject(input.utilities, "utilities"),
    garbageInstructionsEn: normalizeText(
      input.garbageInstructionsEn,
      "garbageInstructionsEn",
    ),
    garbageInstructionsEs: normalizeText(
      input.garbageInstructionsEs,
      "garbageInstructionsEs",
    ),
    checkoutInstructionsEn: normalizeText(
      input.checkoutInstructionsEn,
      "checkoutInstructionsEn",
    ),
    checkoutInstructionsEs: normalizeText(
      input.checkoutInstructionsEs,
      "checkoutInstructionsEs",
    ),
    safetyInformation: normalizeObject(
      input.safetyInformation,
      "safetyInformation",
    ),
    localNotes: normalizeArray(input.localNotes, "localNotes"),
    customFaq: normalizeObject(input.customFaq, "customFaq"),
  });
}

async function assertPropertyInOrganization({
  prisma,
  organizationId,
  propertyId,
}: {
  prisma: PropertyGuestKnowledgePrisma;
  organizationId: string;
  propertyId: string;
}) {
  const property = await prisma.property.findFirst({
    where: {
      id: propertyId,
      organizationId,
      status: "ACTIVE",
    },
    select: { id: true },
  });

  if (!property) {
    throw new Error("PROPERTY_GUEST_KNOWLEDGE_PROPERTY_NOT_FOUND");
  }
}

function normalizeText(
  value: string | null | undefined,
  field: string,
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new Error(`PROPERTY_GUEST_KNOWLEDGE_INVALID_TEXT:${field}`);
  }

  const trimmed = value.trim();
  if (trimmed.length > TEXT_LIMIT) {
    throw new Error(`PROPERTY_GUEST_KNOWLEDGE_TEXT_TOO_LONG:${field}`);
  }

  return trimmed || null;
}

function normalizeObject(
  value: JsonObject | null | undefined,
  field: string,
): JsonObject | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;

  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`PROPERTY_GUEST_KNOWLEDGE_INVALID_OBJECT:${field}`);
  }

  assertJsonSize(value, field);
  return value;
}

function normalizeArray(
  value: readonly unknown[] | null | undefined,
  field: string,
): readonly unknown[] | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (!Array.isArray(value)) {
    throw new Error(`PROPERTY_GUEST_KNOWLEDGE_INVALID_ARRAY:${field}`);
  }

  assertJsonSize(value, field);
  return value;
}

function assertJsonSize(value: unknown, field: string): void {
  const serialized = JSON.stringify(value);
  if (serialized.length > JSON_LIMIT) {
    throw new Error(`PROPERTY_GUEST_KNOWLEDGE_JSON_TOO_LARGE:${field}`);
  }
}

function assertNoOperationalSecrets(value: unknown, path: string[] = []): void {
  if (!value || typeof value !== "object") return;

  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      assertNoOperationalSecrets(item, [...path, String(index)]),
    );
    return;
  }

  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (PROHIBITED_PROPERTY_KNOWLEDGE_KEYS.has(key)) {
      throw new Error(
        `PROPERTY_GUEST_KNOWLEDGE_PROHIBITED_FIELD:${[...path, key].join(".")}`,
      );
    }

    assertNoOperationalSecrets(nested, [...path, key]);
  }
}

function compactUndefined(
  value: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([, nested]) => nested !== undefined),
  );
}
