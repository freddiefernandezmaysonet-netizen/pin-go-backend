export const REVIEW_INVITATION_TTL_DAYS = 30;
export const REVIEW_COMMENT_MAX_LENGTH = 5_000;
export const REVIEW_RESPONSE_MAX_LENGTH = 2_000;

export const REVIEW_STATUSES = [
  "PENDING_MODERATION", "PUBLISHED", "DISPUTED", "HELD_FOR_REVIEW", "REJECTED", "REMOVED",
] as const;
export type ReviewStatusValue = (typeof REVIEW_STATUSES)[number];

export const PUBLIC_REVIEW_SORTS = ["RECENT", "HIGHEST", "LOWEST"] as const;
export type PublicReviewSortValue = (typeof PUBLIC_REVIEW_SORTS)[number];

export const MODERATION_REASONS = [
  "AUTOMATED_SAFETY_CLEAR", "ROUTINE_LOW_RATING_REVIEW", "AUTOMATED_SAFETY_SIGNAL", "UNVERIFIED_STAY", "DUPLICATE",
  "ABUSE_HARASSMENT", "THREAT", "EXTORTION", "PII", "SPAM", "IRRELEVANT",
  "FACTUALLY_CONTRADICTED", "MANIPULATION", "OTHER_POLICY",
] as const;
export type ModerationReasonValue = (typeof MODERATION_REASONS)[number];
export type ModerationActionValue = "PUBLISH" | "UPHOLD" | "REJECT" | "REMOVE" | "HOLD";

export const REVIEW_RESPONSE_STATUSES = ["PUBLISHED", "HELD_FOR_REVIEW", "REMOVED"] as const;
export type ReviewResponseStatusValue = (typeof REVIEW_RESPONSE_STATUSES)[number];
export const RESPONSE_MODERATION_ACTIONS = ["PUBLISH", "HOLD", "REMOVE"] as const;
export type ResponseModerationActionValue = (typeof RESPONSE_MODERATION_ACTIONS)[number];

export type ReviewRatings = {
  overallRating: number;
  cleanlinessRating: number;
  accuracyRating: number;
  checkInAccessRating: number;
  communicationRating: number;
  locationRating: number;
  valueRating: number;
};

const RATING_FIELDS: Array<keyof ReviewRatings> = [
  "overallRating",
  "cleanlinessRating",
  "accuracyRating",
  "checkInAccessRating",
  "communicationRating",
  "locationRating",
  "valueRating",
];

export class ReviewPolicyError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
    this.name = "ReviewPolicyError";
  }
}

export function parseRatings(input: unknown): ReviewRatings {
  const record = (input ?? {}) as Record<string, unknown>;
  const ratings = {} as ReviewRatings;
  for (const field of RATING_FIELDS) {
    const value = Number(record[field]);
    if (!Number.isInteger(value) || value < 1 || value > 5) {
      throw new ReviewPolicyError("REVIEW_RATING_INVALID", `${field} must be an integer from 1 to 5.`);
    }
    ratings[field] = value;
  }
  return ratings;
}

export function parseReviewStatus(value: unknown): ReviewStatusValue | undefined {
  if (value == null || value === "") return undefined;
  const normalized = String(value).trim().toUpperCase();
  if (!(REVIEW_STATUSES as readonly string[]).includes(normalized)) {
    throw new ReviewPolicyError("REVIEW_STATUS_INVALID", "Invalid review status.");
  }
  return normalized as ReviewStatusValue;
}

export function parseModerationReason(value: unknown): ModerationReasonValue {
  const normalized = String(value ?? "OTHER_POLICY").trim().toUpperCase();
  if (!(MODERATION_REASONS as readonly string[]).includes(normalized)) {
    throw new ReviewPolicyError("MODERATION_REASON_INVALID", "Invalid moderation reason.");
  }
  return normalized as ModerationReasonValue;
}

export function parsePositiveInteger(value: unknown, fallback: number, maximum: number): number {
  if (value == null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, maximum);
}

export function parsePublicReviewSort(value: unknown): PublicReviewSortValue {
  const normalized = String(value ?? "RECENT").trim().toUpperCase();
  if (!(PUBLIC_REVIEW_SORTS as readonly string[]).includes(normalized)) {
    throw new ReviewPolicyError("PUBLIC_REVIEW_SORT_INVALID", "Invalid public review sort.");
  }
  return normalized as PublicReviewSortValue;
}

const ALLOWED_MODERATION_ACTIONS: Record<ReviewStatusValue, readonly ModerationActionValue[]> = {
  PENDING_MODERATION: ["PUBLISH", "REJECT", "HOLD"],
  HELD_FOR_REVIEW: ["PUBLISH", "REJECT", "REMOVE", "HOLD"],
  DISPUTED: ["PUBLISH", "REJECT", "HOLD"],
  PUBLISHED: ["UPHOLD", "HOLD"],
  REJECTED: ["PUBLISH", "HOLD"],
  REMOVED: ["PUBLISH", "HOLD"],
};

// Rejecting or removing a review requires a concrete integrity or content-policy
// violation. A low rating, negative sentiment, a broad automated signal, or the
// catch-all OTHER_POLICY reason is not sufficient to suppress guest feedback.
const CONCRETE_ADVERSE_MODERATION_REASONS = [
  "UNVERIFIED_STAY",
  "DUPLICATE",
  "ABUSE_HARASSMENT",
  "THREAT",
  "EXTORTION",
  "PII",
  "SPAM",
  "IRRELEVANT",
  "FACTUALLY_CONTRADICTED",
  "MANIPULATION",
] as const satisfies readonly ModerationReasonValue[];

export const MODERATION_REASON_MATRIX = {
  PUBLISH: MODERATION_REASONS,
  UPHOLD: MODERATION_REASONS,
  HOLD: MODERATION_REASONS.filter((reason) => reason !== "AUTOMATED_SAFETY_CLEAR"),
  REJECT: CONCRETE_ADVERSE_MODERATION_REASONS,
  REMOVE: CONCRETE_ADVERSE_MODERATION_REASONS,
} as const satisfies Readonly<Record<ModerationActionValue, readonly ModerationReasonValue[]>>;

export function assertModerationTransition(status: ReviewStatusValue, action: ModerationActionValue): void {
  if (!ALLOWED_MODERATION_ACTIONS[status].includes(action)) {
    throw new ReviewPolicyError("MODERATION_TRANSITION_INVALID", `Cannot ${action.toLowerCase()} a ${status.toLowerCase()} review.`, 409);
  }
}

export function assertModerationReasonAllowed(action: ModerationActionValue, reason: ModerationReasonValue): void {
  if (!(MODERATION_REASON_MATRIX[action] as readonly ModerationReasonValue[]).includes(reason)) {
    throw new ReviewPolicyError(
      "MODERATION_REASON_ACTION_INVALID",
      `${reason} cannot justify ${action.toLowerCase()} for a guest review. Ratings and sentiment are not policy violations.`,
      409,
    );
  }
}

export function requireModerationEvidence(action: ModerationActionValue, reason: ModerationReasonValue, note: string | null, evidence: unknown): void {
  assertModerationReasonAllowed(action, reason);
  if (action !== "REJECT" && action !== "REMOVE" && action !== "HOLD") return;
  if (!note || note.length < 20) {
    throw new ReviewPolicyError("MODERATION_EVIDENCE_REQUIRED", "Holding, rejecting or removing a review requires a documented evidence summary of at least 20 characters.");
  }
  const record = evidence && typeof evidence === "object" && !Array.isArray(evidence) ? evidence as Record<string, unknown> : null;
  const selectedReference = record?.selectedReference;
  const hasPositiveReference = typeof record?.referenceId === "string" && record.referenceId.trim().length > 0 &&
    Boolean(selectedReference && typeof selectedReference === "object" && !Array.isArray(selectedReference));
  if (reason === "FACTUALLY_CONTRADICTED" && (record?.kind !== "PIN_GO_REVIEW_MODERATION_EVIDENCE" || !hasPositiveReference)) {
    throw new ReviewPolicyError("FACTUAL_CONTRADICTION_EVIDENCE_REQUIRED", "Factual contradiction requires a structured positive Pin&Go evidence reference.");
  }
}

const RESPONSE_CONTENT_POLICY_REASONS = [
  "ABUSE_HARASSMENT",
  "THREAT",
  "EXTORTION",
  "PII",
  "SPAM",
  "IRRELEVANT",
  "FACTUALLY_CONTRADICTED",
  "MANIPULATION",
] as const satisfies readonly ModerationReasonValue[];

export const RESPONSE_MODERATION_REASON_MATRIX = {
  PUBLISH: ["AUTOMATED_SAFETY_CLEAR"],
  HOLD: ["AUTOMATED_SAFETY_SIGNAL", ...RESPONSE_CONTENT_POLICY_REASONS],
  REMOVE: RESPONSE_CONTENT_POLICY_REASONS,
} as const satisfies Readonly<Record<ResponseModerationActionValue, readonly ModerationReasonValue[]>>;

const RESPONSE_MODERATION_TRANSITIONS = {
  PUBLISHED: ["HOLD"],
  HELD_FOR_REVIEW: ["PUBLISH", "REMOVE"],
  REMOVED: ["HOLD"],
} as const satisfies Readonly<Record<ReviewResponseStatusValue, readonly ResponseModerationActionValue[]>>;

export function assertResponseModerationTransition(
  status: ReviewResponseStatusValue,
  action: ResponseModerationActionValue,
): void {
  if (!(RESPONSE_MODERATION_TRANSITIONS[status] as readonly ResponseModerationActionValue[]).includes(action)) {
    throw new ReviewPolicyError(
      "REVIEW_RESPONSE_MODERATION_TRANSITION_INVALID",
      `Cannot ${action.toLowerCase()} a ${status.toLowerCase()} host response.`,
      409,
    );
  }
}

export function requireResponseModerationDecision(
  action: ResponseModerationActionValue,
  reason: ModerationReasonValue,
  note: string | null,
): void {
  if (!(RESPONSE_MODERATION_REASON_MATRIX[action] as readonly ModerationReasonValue[]).includes(reason)) {
    throw new ReviewPolicyError(
      "REVIEW_RESPONSE_MODERATION_REASON_INVALID",
      `${reason} cannot justify ${action.toLowerCase()} for a host response.`,
      409,
    );
  }
  if (!note || note.length < 20) {
    throw new ReviewPolicyError(
      "REVIEW_RESPONSE_MODERATION_NOTE_REQUIRED",
      "Host-response moderation requires an evidence summary of at least 20 characters.",
    );
  }
}

export function normalizeReviewText(value: unknown, field: string, maxLength: number, required = false): string | null {
  if (value == null || value === "") {
    if (required) throw new ReviewPolicyError("REVIEW_TEXT_REQUIRED", `${field} is required.`);
    return null;
  }
  if (typeof value !== "string") throw new ReviewPolicyError("REVIEW_TEXT_INVALID", `${field} must be text.`);
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized && required) throw new ReviewPolicyError("REVIEW_TEXT_REQUIRED", `${field} is required.`);
  if (normalized.length > maxLength) throw new ReviewPolicyError("REVIEW_TEXT_TOO_LONG", `${field} is too long.`);
  return normalized || null;
}

export function normalizeReviewDeliveryError(value: unknown): string {
  const normalized = String(value ?? "")
    .replace(/ReviewToken\s+[A-Za-z0-9_-]{32,256}/gi, "ReviewToken [REDACTED]")
    .replace(/https?:\/\/[^\s<>'\"]+/gi, "[REDACTED_URL]")
    .replace(/(\btoken\s*[:=]\s*)[A-Za-z0-9_-]{32,256}/gi, "$1[REDACTED]")
    .replace(/\s+/g, " ")
    .trim() || "Delivery failed";
  return normalized.slice(0, 5_000);
}

export type SafetySignal = "PII" | "THREAT" | "EXTORTION" | "ABUSE_HARASSMENT" | "SPAM";

export function detectSafetySignals(comment: string): SafetySignal[] {
  const signals = new Set<SafetySignal>();
  if (/\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b/i.test(comment) || /\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/.test(comment)) signals.add("PII");
  if (/\b(kill|matar|hurt you|hacerte da[ñn]o|threat|amenaz)/i.test(comment)) signals.add("THREAT");
  if (/\b(refund|reembolso|money|dinero).{0,45}\b(remove|delete|borrar|eliminar).{0,25}\breview\b/i.test(comment) || /\b(remove|delete|borrar|eliminar).{0,25}\breview\b.{0,45}\b(refund|reembolso|money|dinero)\b/i.test(comment)) signals.add("EXTORTION");
  if (/\b(idiot|stupid|imb[eé]cil|est[uú]pido|puta|fuck you)\b/i.test(comment)) signals.add("ABUSE_HARASSMENT");
  if (/(https?:\/\/\S+.*){2,}/i.test(comment) || /(.)\1{12,}/.test(comment)) signals.add("SPAM");
  return [...signals];
}

export function initialReviewDecision(
  overallRating: number,
  signals: SafetySignal[],
  autoPublishEnabled = false,
) {
  if (signals.length > 0) return { status: "HELD_FOR_REVIEW" as const, reason: "AUTOMATED_SAFETY_SIGNAL" as const };
  if (overallRating <= 3) return { status: "PENDING_MODERATION" as const, reason: "ROUTINE_LOW_RATING_REVIEW" as const };
  if (!autoPublishEnabled) return { status: "PENDING_MODERATION" as const, reason: "AUTOMATED_SAFETY_CLEAR" as const };
  return { status: "PUBLISHED" as const, reason: null };
}

export function guestDisplayName(fullName: string): string {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "Verified guest";
  return parts.length === 1 ? parts[0].slice(0, 40) : `${parts[0]} ${parts.at(-1)?.charAt(0).toUpperCase()}.`.slice(0, 80);
}
