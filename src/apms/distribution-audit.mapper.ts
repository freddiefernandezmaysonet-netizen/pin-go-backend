import type { AuditEntry } from "./audit-types";

type DistributionAuditEntryInput = {
  organizationId?: string | null;
  propertyId: string;
  reservationId?: string | null;
  blockedDateId?: string | null;

  decisionId: string;
  trigger: string;

  provider?: string;
  syncType?: string;

  startedAt: Date;
  completedAt?: Date;

  result?: unknown;
  error?: unknown;

  status?: AuditEntry["status"];
  severity?: AuditEntry["severity"];
  eventType?: AuditEntry["eventType"];

  reason?: string;
  summary?: string;
  rule?: string;
  label?: string;
  recommendedAction?: string;

  metadata?: Record<string, unknown>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function getBooleanSignal(value: unknown, key: string) {
  if (!isRecord(value)) return null;

  const signal = value[key];

  return typeof signal === "boolean" ? signal : null;
}

function getStringSignal(value: unknown, key: string) {
  if (!isRecord(value)) return null;

  const signal = value[key];

  return typeof signal === "string" ? signal : null;
}

function toErrorMessage(error: unknown) {
  if (!error) return null;

  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  return String(error);
}

function compactObject(input: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined)
  );
}

function normalizeReasonPart(value: string) {
  return value
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function getDefaultReason(input: {
  trigger: string;
  hasError: boolean;
  succeeded: boolean;
}) {
  const trigger = normalizeReasonPart(input.trigger);

  if (input.hasError) {
    return `${trigger}_DISTRIBUTION_SYNC_ERROR`;
  }

  return input.succeeded
    ? `${trigger}_DISTRIBUTION_SYNC_COMPLETED`
    : `${trigger}_DISTRIBUTION_SYNC_FAILED`;
}

function getDefaultSummary(input: {
  trigger: string;
  provider: string;
  syncType: string;
  hasError: boolean;
  succeeded: boolean;
}) {
  const trigger = input.trigger
    .toLowerCase()
    .replace(/_/g, " ");

  if (input.hasError) {
    return `Distribution Engine failed to synchronize ${input.syncType.toLowerCase()} with ${input.provider} after ${trigger}.`;
  }

  return input.succeeded
    ? `Distribution Engine synchronized ${input.syncType.toLowerCase()} with ${input.provider} after ${trigger}.`
    : `Distribution Engine could not fully synchronize ${input.syncType.toLowerCase()} with ${input.provider} after ${trigger}.`;
}

export function createDistributionAuditEntry(
  input: DistributionAuditEntryInput
): AuditEntry {
  const provider = input.provider ?? "CHANNEX";
  const syncType = input.syncType ?? "AVAILABILITY";
  const completedAt = input.completedAt ?? new Date();

  const resultOk = getBooleanSignal(input.result, "ok");
  const pushedToChannex = getBooleanSignal(input.result, "pushedToChannex");
  const skipped = getBooleanSignal(input.result, "skipped");
  const skipReason = getStringSignal(input.result, "reason");
  const errorMessage = toErrorMessage(input.error);

  const succeeded =
    input.status !== undefined
      ? input.status === "SUCCESS"
      : errorMessage
      ? false
      : resultOk ?? true;

  const status: AuditEntry["status"] =
    input.status ?? (succeeded ? "SUCCESS" : "FAILED");

  const severity: AuditEntry["severity"] =
    input.severity ?? (succeeded ? "INFO" : errorMessage ? "CRITICAL" : "WARNING");

  const eventType: AuditEntry["eventType"] =
    input.eventType ?? (succeeded ? "SYNC_COMPLETED" : "SYNC_FAILED");

  const reason =
    input.reason ??
    getDefaultReason({
      trigger: input.trigger,
      hasError: Boolean(errorMessage),
      succeeded,
    });

  const summary =
    input.summary ??
    getDefaultSummary({
      trigger: input.trigger,
      provider,
      syncType,
      hasError: Boolean(errorMessage),
      succeeded,
    });

  const metadata = compactObject({
    ...(input.metadata ?? {}),
    organizationId: input.organizationId ?? undefined,
    propertyId: input.propertyId,
    reservationId: input.reservationId ?? undefined,
    blockedDateId: input.blockedDateId ?? undefined,
    provider,
    syncType,
    trigger: input.trigger,
    resultOk,
    pushedToChannex,
    skipped,
    skipReason,
    error: errorMessage ?? undefined,
  });

  return {
    engine: "Distribution",
    decisionId: input.decisionId,
    entityType: "DISTRIBUTION",
    entityId: input.propertyId,
    eventType,
    status,
    severity,
    summary,
    startedAt: input.startedAt,
    completedAt,
    durationMs: completedAt.getTime() - input.startedAt.getTime(),
    reason,
    decisions: [
      {
        engine: "Distribution",
        rule:
          input.rule ??
          `${normalizeReasonPart(input.trigger)}_${provider}_${syncType}_SYNC`,
        label: input.label ?? "Distribution Channel Sync",
        applied: succeeded,
        adjustment: null,
        adjustmentPercent: null,
        confidence: succeeded ? 100 : 0,
        metadata,
      },
    ],
    recommendedAction: input.recommendedAction,
    metadata,
  };
}