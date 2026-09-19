import type { MockToolName } from "./contracts.js";

export type PropertyKnowledgeSource =
  | "PROPERTY"
  | "AMENITY"
  | "LOCK"
  | "PROPERTY_DEVICE"
  | "GUEST_AGREEMENT"
  | "CANCELLATION_POLICY"
  | "PROPERTY_GUEST_KNOWLEDGE";

export type PropertyKnowledgeCategory =
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
  | "CANCELLATION";

export type PropertyKnowledgeFact = Readonly<{
  category: PropertyKnowledgeCategory;
  key: string;
  value: unknown;
  source: PropertyKnowledgeSource;
  authoritative: boolean;
  guestVisible: boolean;
}>;

export type PropertyKnowledgeSnapshot = Readonly<{
  organizationId: string;
  propertyId: string;
  language: "en" | "es";
  facts: readonly PropertyKnowledgeFact[];
}>;

export type PropertyGuestKnowledgeDraft = Readonly<{
  wifi?: Readonly<{
    ssid?: string;
    password?: string;
    notes?: string;
  }>;
  parking?: Readonly<{
    instructions?: string;
    restrictions?: string;
  }>;
  arrivalInstructions?: string;
  accessInstructions?: string;
  applianceGuides?: Readonly<Record<string, string>>;
  troubleshooting?: Readonly<Record<string, string>>;
  utilities?: Readonly<Record<string, string>>;
  garbageInstructions?: string;
  checkoutInstructions?: string;
  safetyInformation?: Readonly<Record<string, string>>;
  localNotes?: readonly string[];
  customFaq?: Readonly<Record<string, string>>;
}>;

export const PROPERTY_KNOWLEDGE_PROHIBITED_KEYS = [
  "activePasscode",
  "futurePasscode",
  "nfcCredential",
  "stripeSecret",
  "paymentMethod",
  "identityDocument",
  "governmentId",
  "refundAuthorization",
] as const;

export function assertPropertyKnowledgeSafe(value: unknown): void {
  scan(value, []);
}

function scan(value: unknown, path: string[]): void {
  if (!value || typeof value !== "object") return;

  if (Array.isArray(value)) {
    value.forEach((item, index) => scan(item, [...path, String(index)]));
    return;
  }

  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (PROPERTY_KNOWLEDGE_PROHIBITED_KEYS.includes(key as (typeof PROPERTY_KNOWLEDGE_PROHIBITED_KEYS)[number])) {
      throw new Error(`PROPERTY_KNOWLEDGE_PROHIBITED_FIELD:${[...path, key].join(".")}`);
    }
    scan(nested, [...path, key]);
  }
}

export const PROPERTY_KNOWLEDGE_TOOL_NAME: MockToolName = "get_property_knowledge";
