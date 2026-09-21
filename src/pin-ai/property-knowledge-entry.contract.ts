export const PROPERTY_KNOWLEDGE_CATEGORIES = [
  "PROPERTY",
  "ARRIVAL",
  "ACCESS",
  "WIFI",
  "PARKING",
  "AMENITIES",
  "HOUSE_RULES",
  "APPLIANCE",
  "TROUBLESHOOTING",
  "EMERGENCY",
  "LOCAL_GUIDE",
] as const;

export const PROPERTY_KNOWLEDGE_VISIBILITIES = [
  "PUBLIC",
  "CONFIRMED_GUEST",
  "DURING_STAY",
] as const;

export type PropertyKnowledgeEntryCategory =
  (typeof PROPERTY_KNOWLEDGE_CATEGORIES)[number];

export type PropertyKnowledgeEntryVisibility =
  (typeof PROPERTY_KNOWLEDGE_VISIBILITIES)[number];

export type PropertyKnowledgeEntryDraft = Readonly<{
  category: PropertyKnowledgeEntryCategory;
  key: string;
  titleEn: string | null;
  titleEs: string | null;
  contentEn: string | null;
  contentEs: string | null;
  visibility: PropertyKnowledgeEntryVisibility;
  sortOrder: number;
}>;

const KNOWLEDGE_KEY_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const ACCESS_CREDENTIAL_KEY_PATTERN =
  /(?:^|[._-])(?:(?:access|door|lock)[._-]?(?:code|pin|passcode|credential)|activepasscode|futurepasscode|passcode|pin|credential|nfccredential)(?:$|[._-])/i;
const ACCESS_CREDENTIAL_CONTENT_PATTERN =
  /\b(?:door|lock|entry|access)?\s*(?:passcode|pin|code|credential)\s*(?:is|:|=)\s*(?=[a-z0-9-]{4,12}\b)(?=[a-z0-9-]*\d)[a-z0-9-]+\b/i;

function normalizeOptionalText(value: unknown, maxLength: number): string | null {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim();
  if (!normalized) return null;
  if (normalized.length > maxLength) {
    throw new Error("PROPERTY_KNOWLEDGE_TEXT_TOO_LONG");
  }
  if (/\u0000/.test(normalized)) {
    throw new Error("PROPERTY_KNOWLEDGE_TEXT_INVALID");
  }
  return normalized;
}

export function normalizePropertyKnowledgeEntryDraft(
  input: Readonly<Record<string, unknown>>,
): PropertyKnowledgeEntryDraft {
  const category = String(input.category ?? "").trim().toUpperCase();
  if (
    !PROPERTY_KNOWLEDGE_CATEGORIES.includes(
      category as PropertyKnowledgeEntryCategory,
    )
  ) {
    throw new Error("PROPERTY_KNOWLEDGE_CATEGORY_INVALID");
  }

  const key = String(input.key ?? "").trim().toLowerCase();
  if (!key || key.length > 80 || !KNOWLEDGE_KEY_PATTERN.test(key)) {
    throw new Error("PROPERTY_KNOWLEDGE_KEY_INVALID");
  }

  if (ACCESS_CREDENTIAL_KEY_PATTERN.test(key)) {
    throw new Error("PROPERTY_KNOWLEDGE_ACCESS_CREDENTIAL_FORBIDDEN");
  }

  const visibility = String(input.visibility ?? "CONFIRMED_GUEST")
    .trim()
    .toUpperCase();
  if (
    !PROPERTY_KNOWLEDGE_VISIBILITIES.includes(
      visibility as PropertyKnowledgeEntryVisibility,
    )
  ) {
    throw new Error("PROPERTY_KNOWLEDGE_VISIBILITY_INVALID");
  }

  if (category === "WIFI" && visibility === "PUBLIC") {
    throw new Error("PROPERTY_KNOWLEDGE_WIFI_PUBLIC_FORBIDDEN");
  }

  const titleEn = normalizeOptionalText(input.titleEn, 160);
  const titleEs = normalizeOptionalText(input.titleEs, 160);
  const contentEn = normalizeOptionalText(input.contentEn, 4_000);
  const contentEs = normalizeOptionalText(input.contentEs, 4_000);

  if (!contentEn && !contentEs) {
    throw new Error("PROPERTY_KNOWLEDGE_CONTENT_REQUIRED");
  }

  for (const content of [contentEn, contentEs]) {
    if (content && ACCESS_CREDENTIAL_CONTENT_PATTERN.test(content)) {
      throw new Error("PROPERTY_KNOWLEDGE_ACCESS_CREDENTIAL_FORBIDDEN");
    }
  }

  const sortOrder = Number(input.sortOrder ?? 0);
  if (!Number.isInteger(sortOrder) || sortOrder < 0 || sortOrder > 10_000) {
    throw new Error("PROPERTY_KNOWLEDGE_SORT_ORDER_INVALID");
  }

  return {
    category: category as PropertyKnowledgeEntryCategory,
    key,
    titleEn,
    titleEs,
    contentEn,
    contentEs,
    visibility: visibility as PropertyKnowledgeEntryVisibility,
    sortOrder,
  };
}
