import {
  buildChannexAriPropertyPause,
  type ChannexAriDispatchPropertyState,
} from "./channex-ari-dispatch.policy";
import {
  CHANNEX_ARI_MAX_ATTEMPTS,
  classifyChannexAriAttempt,
  getRetryDelayMs,
  type ChannexAriMessageKind,
  type ChannexAriRetryClass,
  type ChannexAriSyncMode,
} from "./channex-ari-lifecycle.policy";

export type ChannexAriAttemptCompletionDelivery = {
  status: "PROCESSING";
  messageKind: ChannexAriMessageKind;
  syncMode: ChannexAriSyncMode;
  attemptCount: number;
  leaseToken: string;
  leaseExpiresAt: Date;
};

export type ChannexAriAttemptCompletionAttempt = {
  attemptNumber: number;
  outcome: "IN_FLIGHT";
  startedAt: Date;
  completedAt?: Date | null;
};

export type ChannexAriAttemptCompletionEvidence = {
  httpStatus?: number | null;
  networkError?: boolean;
  timedOut?: boolean;
  taskId?: string | null;
  warningCount?: number | null;
  retryAfterMs?: number | null;
  errorCode?: string | null;
  errorSummary?: string | null;
  responseMeta?: Record<string, unknown> | null;
};

export type ChannexAriAttemptCompletionPropertyState = Pick<
  ChannexAriDispatchPropertyState,
  "pausedUntil"
>;

export type ChannexAriAttemptCompletionAttemptOutcome =
  | "SUCCESS"
  | "RETRYABLE_FAILURE"
  | "TERMINAL_FAILURE";

function requireText(value: unknown, errorCode: string): string {
  const normalized = String(value ?? "").trim();

  if (!normalized) {
    throw new Error(errorCode);
  }

  return normalized;
}

function normalizeOptionalText(input: {
  value: unknown;
  maxLength: number;
  errorCode: string;
}): string | null {
  const normalized = String(input.value ?? "").trim();

  if (!normalized) return null;

  if (normalized.length > input.maxLength) {
    throw new Error(input.errorCode);
  }

  return normalized;
}

function assertValidDate(value: Date, errorCode: string): Date {
  const normalized = new Date(value);

  if (Number.isNaN(normalized.getTime())) {
    throw new Error(errorCode);
  }

  return normalized;
}

function assertAttemptNumber(value: number): number {
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > CHANNEX_ARI_MAX_ATTEMPTS
  ) {
    throw new Error("CHANNEX_ARI_COMPLETION_ATTEMPT_NUMBER_INVALID");
  }

  return value;
}

function normalizeHttpStatus(value: number | null | undefined): number | null {
  if (value == null) return null;

  const normalized = Number(value);

  if (
    !Number.isSafeInteger(normalized) ||
    normalized < 100 ||
    normalized > 599
  ) {
    throw new Error("CHANNEX_ARI_COMPLETION_HTTP_STATUS_INVALID");
  }

  return normalized;
}

function normalizeNonNegativeInteger(input: {
  value: number | null | undefined;
  errorCode: string;
}): number {
  const normalized = Number(input.value ?? 0);

  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    throw new Error(input.errorCode);
  }

  return normalized;
}

function normalizeResponseMeta(
  value: Record<string, unknown> | null | undefined
): Record<string, unknown> {
  if (value == null) return {};

  if (
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new Error("CHANNEX_ARI_COMPLETION_RESPONSE_META_INVALID");
  }

  return { ...value };
}

function laterDate(left: Date | null, right: Date): Date {
  if (!left) return right;
  return left.getTime() >= right.getTime() ? left : right;
}

function defaultErrorCode(input: {
  retryClass: ChannexAriRetryClass;
  httpStatus: number | null;
  networkError: boolean;
  timedOut: boolean;
  taskId: string | null;
  warningCount: number;
}): string | null {
  if (input.retryClass === "SUCCESS") return null;
  if (input.timedOut) return "CHANNEX_ARI_TIMEOUT";
  if (input.networkError) return "CHANNEX_ARI_NETWORK_ERROR";
  if (input.httpStatus === 429) return "CHANNEX_ARI_RATE_LIMITED";
  if (input.httpStatus != null && input.httpStatus >= 500) {
    return "CHANNEX_ARI_UPSTREAM_5XX";
  }
  if (
    input.httpStatus != null &&
    input.httpStatus >= 200 &&
    input.httpStatus < 300 &&
    input.warningCount > 0
  ) {
    return "CHANNEX_ARI_REJECTED_VALUE_WARNING";
  }
  if (input.httpStatus != null) {
    return `CHANNEX_ARI_HTTP_${input.httpStatus}`;
  }
  return input.retryClass === "RETRYABLE"
    ? "CHANNEX_ARI_RETRYABLE_FAILURE"
    : "CHANNEX_ARI_TERMINAL_FAILURE";
}

function defaultErrorSummary(input: {
  retryClass: ChannexAriRetryClass;
  httpStatus: number | null;
  networkError: boolean;
  timedOut: boolean;
  taskId: string | null;
  warningCount: number;
}): string | null {
  if (input.retryClass === "SUCCESS") return null;
  if (input.timedOut) return "Channex ARI request timed out.";
  if (input.networkError) return "Channex ARI request failed before an HTTP response.";
  if (input.httpStatus === 429) return "Channex rate-limited the ARI request.";
  if (input.httpStatus != null && input.httpStatus >= 500) {
    return `Channex returned retryable HTTP ${input.httpStatus}.`;
  }
  if (
    input.httpStatus != null &&
    input.httpStatus >= 200 &&
    input.httpStatus < 300 &&
    input.warningCount > 0
  ) {
    return `Channex returned ${input.warningCount} rejected-value warning(s).`;
  }
  if (input.httpStatus != null) {
    return `Channex returned terminal HTTP ${input.httpStatus}.`;
  }
  return input.retryClass === "RETRYABLE"
    ? "Channex ARI delivery failed with a retryable error."
    : "Channex ARI delivery failed with a terminal error.";
}

function buildSuccessPropertyStateUpdate(input: {
  messageKind: ChannexAriMessageKind;
  syncMode: ChannexAriSyncMode;
  completedAt: Date;
}) {
  return {
    ...(input.messageKind === "AVAILABILITY"
      ? { lastSuccessfulAvailabilityAt: input.completedAt }
      : { lastSuccessfulRatesAt: input.completedAt }),
    ...(input.syncMode === "FULL"
      ? { lastFullSyncCompletedAt: input.completedAt }
      : {}),
  };
}

export function buildChannexAriAttemptCompletion(input: {
  delivery: ChannexAriAttemptCompletionDelivery;
  attempt: ChannexAriAttemptCompletionAttempt;
  leaseToken: string;
  evidence: ChannexAriAttemptCompletionEvidence;
  propertyState?: ChannexAriAttemptCompletionPropertyState;
  completedAt: Date;
  jitterMs?: number;
}) {
  if (input.delivery.status !== "PROCESSING") {
    throw new Error("CHANNEX_ARI_COMPLETION_PROCESSING_REQUIRED");
  }

  const attemptNumber = assertAttemptNumber(input.delivery.attemptCount);
  const persistedLeaseToken = requireText(
    input.delivery.leaseToken,
    "CHANNEX_ARI_COMPLETION_PERSISTED_LEASE_TOKEN_REQUIRED"
  );
  const suppliedLeaseToken = requireText(
    input.leaseToken,
    "CHANNEX_ARI_COMPLETION_LEASE_TOKEN_REQUIRED"
  );
  const leaseExpiresAt = assertValidDate(
    input.delivery.leaseExpiresAt,
    "CHANNEX_ARI_COMPLETION_LEASE_EXPIRES_AT_INVALID"
  );

  if (persistedLeaseToken !== suppliedLeaseToken) {
    throw new Error("CHANNEX_ARI_COMPLETION_LEASE_TOKEN_MISMATCH");
  }

  const persistedAttemptNumber = assertAttemptNumber(input.attempt.attemptNumber);

  if (persistedAttemptNumber !== attemptNumber) {
    throw new Error("CHANNEX_ARI_COMPLETION_ATTEMPT_NUMBER_MISMATCH");
  }

  if (input.attempt.outcome !== "IN_FLIGHT" || input.attempt.completedAt) {
    throw new Error("CHANNEX_ARI_COMPLETION_ATTEMPT_STATE_INVALID");
  }

  const startedAt = assertValidDate(
    input.attempt.startedAt,
    "CHANNEX_ARI_COMPLETION_STARTED_AT_INVALID"
  );
  const completedAt = assertValidDate(
    input.completedAt,
    "CHANNEX_ARI_COMPLETION_COMPLETED_AT_INVALID"
  );

  if (completedAt.getTime() < startedAt.getTime()) {
    throw new Error("CHANNEX_ARI_COMPLETION_BEFORE_ATTEMPT_START");
  }

  const httpStatus = normalizeHttpStatus(input.evidence.httpStatus);
  const networkError = Boolean(input.evidence.networkError);
  const timedOut = Boolean(input.evidence.timedOut);

  if (httpStatus != null && (networkError || timedOut)) {
    throw new Error("CHANNEX_ARI_COMPLETION_TRANSPORT_EVIDENCE_CONFLICT");
  }

  if (httpStatus == null && !networkError && !timedOut) {
    throw new Error("CHANNEX_ARI_COMPLETION_TRANSPORT_EVIDENCE_REQUIRED");
  }

  const taskId = normalizeOptionalText({
    value: input.evidence.taskId,
    maxLength: 256,
    errorCode: "CHANNEX_ARI_COMPLETION_TASK_ID_TOO_LONG",
  });
  const warningCount = normalizeNonNegativeInteger({
    value: input.evidence.warningCount,
    errorCode: "CHANNEX_ARI_COMPLETION_WARNING_COUNT_INVALID",
  });
  const retryAfterMs = normalizeNonNegativeInteger({
    value: input.evidence.retryAfterMs,
    errorCode: "CHANNEX_ARI_COMPLETION_RETRY_AFTER_MS_INVALID",
  });
  const responseMeta = normalizeResponseMeta(input.evidence.responseMeta);
  const retryClass = classifyChannexAriAttempt({
    httpStatus,
    networkError,
    timedOut,
    taskId,
    warningCount,
  });
  const providedErrorCode = normalizeOptionalText({
    value: input.evidence.errorCode,
    maxLength: 128,
    errorCode: "CHANNEX_ARI_COMPLETION_ERROR_CODE_TOO_LONG",
  });
  const providedErrorSummary = normalizeOptionalText({
    value: input.evidence.errorSummary,
    maxLength: 1_000,
    errorCode: "CHANNEX_ARI_COMPLETION_ERROR_SUMMARY_TOO_LONG",
  });
  const generatedErrorCode = defaultErrorCode({
    retryClass,
    httpStatus,
    networkError,
    timedOut,
    taskId,
    warningCount,
  });
  const generatedErrorSummary = defaultErrorSummary({
    retryClass,
    httpStatus,
    networkError,
    timedOut,
    taskId,
    warningCount,
  });
  const errorCode =
    retryClass === "SUCCESS" ? null : providedErrorCode ?? generatedErrorCode;
  const errorSummary =
    retryClass === "SUCCESS"
      ? null
      : providedErrorSummary ?? generatedErrorSummary;
  const durationMs = completedAt.getTime() - startedAt.getTime();
  const attemptOutcome: ChannexAriAttemptCompletionAttemptOutcome =
    retryClass === "SUCCESS"
      ? "SUCCESS"
      : retryClass === "RETRYABLE"
        ? "RETRYABLE_FAILURE"
        : "TERMINAL_FAILURE";
  const normalizedResponseMeta = {
    ...responseMeta,
    retryClass,
    networkError,
    timedOut,
    leaseExpiresAt: leaseExpiresAt.toISOString(),
    ...(errorSummary ? { errorSummary } : {}),
  };
  const attemptUpdate = {
    outcome: attemptOutcome,
    completedAt,
    durationMs,
    httpStatus,
    channexTaskId: taskId,
    warningCount,
    retryAfterMs: retryAfterMs || null,
    errorCode,
    responseMeta: normalizedResponseMeta,
  };

  if (retryClass === "SUCCESS") {
    return {
      retryClass,
      exhausted: false,
      retryDelayMs: null,
      deliveryUpdate: {
        status: "SENT" as const,
        nextAttemptAt: null,
        leaseToken: null,
        leaseExpiresAt: null,
        channexTaskId: taskId,
        httpStatus,
        warningCount,
        lastErrorCode: null,
        lastErrorSummary: null,
        sentAt: completedAt,
      },
      attemptUpdate,
      propertyStateUpdate: buildSuccessPropertyStateUpdate({
        messageKind: input.delivery.messageKind,
        syncMode: input.delivery.syncMode,
        completedAt,
      }),
    };
  }

  if (retryClass === "TERMINAL") {
    return {
      retryClass,
      exhausted: false,
      retryDelayMs: null,
      deliveryUpdate: {
        status: "DEAD" as const,
        nextAttemptAt: null,
        leaseToken: null,
        leaseExpiresAt: null,
        channexTaskId: taskId,
        httpStatus,
        warningCount,
        lastErrorCode: errorCode,
        lastErrorSummary: errorSummary,
        deadAt: completedAt,
      },
      attemptUpdate,
      propertyStateUpdate: {},
    };
  }

  const retryDelayMs = getRetryDelayMs({
    attemptNumber,
    retryAfterMs,
    jitterMs: input.jitterMs,
  });
  const pause = buildChannexAriPropertyPause({
    now: completedAt,
    requestedPauseMs: retryDelayMs,
    retryAfterMs,
  });
  const pausedUntil = laterDate(
    input.propertyState?.pausedUntil
      ? assertValidDate(
          input.propertyState.pausedUntil,
          "CHANNEX_ARI_COMPLETION_PROPERTY_PAUSED_UNTIL_INVALID"
        )
      : null,
    pause.pausedUntil
  );
  const exhausted = attemptNumber >= CHANNEX_ARI_MAX_ATTEMPTS;

  return {
    retryClass,
    exhausted,
    retryDelayMs,
    deliveryUpdate: exhausted
      ? {
          status: "DEAD" as const,
          nextAttemptAt: null,
          leaseToken: null,
          leaseExpiresAt: null,
          channexTaskId: taskId,
          httpStatus,
          warningCount,
          lastErrorCode: errorCode,
          lastErrorSummary: errorSummary,
          deadAt: completedAt,
        }
      : {
          status: "RETRY_WAIT" as const,
          nextAttemptAt: new Date(completedAt.getTime() + retryDelayMs),
          leaseToken: null,
          leaseExpiresAt: null,
          channexTaskId: taskId,
          httpStatus,
          warningCount,
          lastErrorCode: errorCode,
          lastErrorSummary: errorSummary,
        },
    attemptUpdate,
    propertyStateUpdate: {
      pausedUntil,
      ...(httpStatus === 429 ? { lastRateLimitAt: completedAt } : {}),
    },
  };
}
