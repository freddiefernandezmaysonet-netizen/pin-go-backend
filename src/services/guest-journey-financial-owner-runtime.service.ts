import { createHash } from "node:crypto";

import {
  GuestJourneyCoordinationAttemptOutcome,
  GuestJourneyCoordinationIntentStatus,
  PaymentState,
  Prisma,
  PrismaClient,
} from "@prisma/client";

import { persistAuditEntry } from "../apms/audit-persistence.service";
import type { AuditEntry } from "../apms/audit-types";
import {
  GUEST_JOURNEY_FINANCIAL_OWNER_VERSION,
  GUEST_JOURNEY_PAYMENT_EVALUATION_HANDLER_CODE,
} from "./guest-journey-contract";

const MAX_RETRY_DELAY_MS = 6 * 60 * 60_000;

type RuntimeTx = Pick<
  Prisma.TransactionClient,
  | "guestJourneyCoordinationIntent"
  | "guestJourneyCoordinationIntentAttempt"
  | "apmsAuditEntry"
>;

export type FinancialOwnerRuntimeDb = {
  $transaction<T>(
    callback: (tx: RuntimeTx) => Promise<T>,
    options?: { isolationLevel?: "Serializable" }
  ): Promise<T>;
};

export type FinancialOwnerScope = {
  organizationIds: string[];
  propertyIds: string[];
};

export type ClaimedFinancialIntent = {
  intentId: string;
  intentKey: string;
  reservationId: string;
  journeyId: string;
  organizationId: string;
  propertyId: string;
  targetEngine: "FINANCIAL";
  intentType: "REQUEST_PAYMENT_EVALUATION";
  expectedOutcomeCode: "PAYMENT_STATE_RESOLVED";
  inputEvidenceFingerprint: string;
  attemptNumber: number;
  leaseToken: string;
  leaseExpiresAt: Date;
};

export type FinancialOwnerCompletion =
  | {
      kind: "SUCCEEDED";
      outcomeEvidenceFingerprint: string;
      action:
        | "PAYMENT_ALREADY_SATISFIED"
        | "PAYMENT_NOT_REQUIRED_FOR_TERMINAL_RESERVATION";
      paymentState: PaymentState;
      hostPayoutStatus?: string | null;
    }
  | {
      kind: "WAITING_FOR_EVIDENCE" | "RETRYABLE" | "EXHAUSTED";
      outcomeEvidenceFingerprint?: string;
      errorCode: string;
      errorDetail: string;
      paymentState?: PaymentState | null;
      hostPayoutStatus?: string | null;
      retryAt?: Date | null;
    };

export type FinancialOwnerCompletionResult = {
  intentId: string;
  attemptNumber: number;
  status: "SUCCEEDED" | "WAITING_FOR_EVIDENCE" | "RETRYABLE" | "EXHAUSTED";
  nextActionAt: Date | null;
};

export type ClaimFinancialIntentResult =
  | {
      claimed: true;
      recoveredStaleLease: boolean;
      claim: ClaimedFinancialIntent;
    }
  | {
      claimed: false;
      reason:
        | "NOT_FOUND"
        | "NOT_ELIGIBLE"
        | "NOT_DUE"
        | "LIVE_LEASE"
        | "CLAIM_RACE"
        | "EXHAUSTED";
    };

function requireText(value: unknown, code: string): string {
  const clean = String(value ?? "").trim();
  if (!clean) throw new Error(code);
  return clean;
}

function requireDate(value: Date, code: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(code);
  return date;
}

function requirePositive(value: number, code: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(code);
  return value;
}

function tokenFingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function scopeAllows(
  organizationId: string,
  propertyId: string,
  scope: FinancialOwnerScope
): boolean {
  return scope.organizationIds.includes(organizationId) ||
    scope.propertyIds.includes(propertyId);
}

export function normalizeFinancialOwnerError(error: unknown): {
  code: string;
  detail: string;
} {
  const raw = error instanceof Error ? error.message : String(error);
  const redacted = raw
    .replace(/:\/\/[^\s/@:]+:[^\s/@]+@/g, "://[REDACTED]@")
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [REDACTED]")
    .replace(/\b(password|secret|token|api[_-]?key|payment[_-]?intent|checkout[_-]?session)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]");
  const code = redacted
    .split(":", 1)[0]
    .trim()
    .replace(/[^A-Z0-9_]/gi, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .toUpperCase() || "UNKNOWN_ERROR";
  const detail = redacted.slice(0, 8_000);
  return { code, detail };
}

function assertContract(intent: {
  targetEngine: string;
  intentType: string;
  expectedOutcomeCode: string;
}): void {
  if (
    intent.targetEngine !== "FINANCIAL" ||
    intent.intentType !== "REQUEST_PAYMENT_EVALUATION" ||
    intent.expectedOutcomeCode !== "PAYMENT_STATE_RESOLVED"
  ) {
    throw new Error("GUEST_JOURNEY_FINANCIAL_OWNER_HANDLER_CONTRACT_MISMATCH");
  }
}

function buildAudit(input: {
  action:
    | "CLAIMED"
    | "LEASE_EXPIRED"
    | "SUCCEEDED"
    | "WAITING_FOR_EVIDENCE"
    | "RETRYABLE"
    | "EXHAUSTED";
  intent: {
    id: string;
    intentKey: string;
    reservationId: string;
    organizationId: string;
    propertyId: string;
  };
  attemptNumber: number;
  startedAt: Date;
  completedAt: Date;
  inputFingerprint: string;
  outputFingerprint?: string | null;
  leaseFingerprint: string;
  errorCode?: string | null;
  paymentState?: PaymentState | null;
  hostPayoutStatus?: string | null;
}): AuditEntry {
  const success = ["CLAIMED", "SUCCEEDED", "WAITING_FOR_EVIDENCE"].includes(input.action);
  return {
    engine: "FINANCIAL",
    decisionId: `guest-journey:financial-owner:${input.intent.id}:${input.attemptNumber}:${input.action.toLowerCase()}`,
    entityType: "RESERVATION",
    entityId: input.intent.reservationId,
    eventType: input.action === "CLAIMED" ? "ACTION_STARTED" : success ? "ACTION_COMPLETED" : "ACTION_FAILED",
    status: success ? "SUCCESS" : "FAILED",
    severity: input.action === "EXHAUSTED" ? "CRITICAL" : ["RETRYABLE", "LEASE_EXPIRED"].includes(input.action) ? "WARNING" : "INFO",
    summary: `Guest Journey FINANCIAL owner attempt ${input.attemptNumber} ${input.action.toLowerCase().replaceAll("_", " ")}.`,
    reason: input.errorCode ?? "The canonical FINANCIAL evaluation was fenced and persisted.",
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    durationMs: Math.max(0, input.completedAt.getTime() - input.startedAt.getTime()),
    metadata: {
      runtime: GUEST_JOURNEY_FINANCIAL_OWNER_VERSION,
      handlerCode: GUEST_JOURNEY_PAYMENT_EVALUATION_HANDLER_CODE,
      intentId: input.intent.id,
      intentKey: input.intent.intentKey,
      intentType: "REQUEST_PAYMENT_EVALUATION",
      attemptNumber: input.attemptNumber,
      organizationId: input.intent.organizationId,
      propertyId: input.intent.propertyId,
      reservationId: input.intent.reservationId,
      paymentState: input.paymentState ?? null,
      hostPayoutStatus: input.hostPayoutStatus ?? null,
      inputEvidenceFingerprint: input.inputFingerprint,
      outcomeEvidenceFingerprint: input.outputFingerprint ?? null,
      leaseTokenFingerprint: input.leaseFingerprint,
      errorCode: input.errorCode ?? null,
    },
  };
}

const intentSelect = {
  id: true,
  intentKey: true,
  reservationId: true,
  journeyId: true,
  intentType: true,
  targetEngine: true,
  expectedOutcomeCode: true,
  evidenceFingerprint: true,
  status: true,
  claimCount: true,
  leaseToken: true,
  claimedAt: true,
  leaseExpiresAt: true,
  nextActionAt: true,
  reservation: {
    select: {
      propertyId: true,
      property: { select: { organizationId: true } },
    },
  },
} as const;

type IntentSnapshot = Prisma.GuestJourneyCoordinationIntentGetPayload<{
  select: typeof intentSelect;
}>;

function compareWhere(intent: IntentSnapshot) {
  return {
    id: intent.id,
    status: intent.status,
    claimCount: intent.claimCount,
    leaseToken: intent.leaseToken,
    claimedAt: intent.claimedAt,
    leaseExpiresAt: intent.leaseExpiresAt,
    nextActionAt: intent.nextActionAt,
  };
}

async function exhaustIntent(
  tx: RuntimeTx,
  intent: IntentSnapshot,
  now: Date,
  errorCode: string,
  leaseFingerprint: string
): Promise<boolean> {
  assertContract(intent);
  const updated = await tx.guestJourneyCoordinationIntent.updateMany({
    where: compareWhere(intent),
    data: {
      status: GuestJourneyCoordinationIntentStatus.EXHAUSTED,
      leaseToken: null,
      claimedAt: null,
      leaseExpiresAt: null,
      nextActionAt: null,
      exhaustedAt: now,
      lastError: errorCode,
    },
  });
  if (updated.count !== 1) return false;
  await persistAuditEntry(tx, buildAudit({
    action: "EXHAUSTED",
    intent: {
      id: intent.id,
      intentKey: intent.intentKey,
      reservationId: intent.reservationId,
      organizationId: intent.reservation.property.organizationId,
      propertyId: intent.reservation.propertyId,
    },
    attemptNumber: Math.max(1, intent.claimCount),
    startedAt: intent.claimedAt ?? now,
    completedAt: now,
    inputFingerprint: intent.evidenceFingerprint,
    leaseFingerprint,
    errorCode,
  }));
  return true;
}

export async function claimGuestJourneyFinancialIntent(
  db: FinancialOwnerRuntimeDb,
  input: {
    intentId: string;
    leaseToken: string;
    scope: FinancialOwnerScope;
    leaseMs: number;
    maxClaims: number;
    now?: Date;
  }
): Promise<ClaimFinancialIntentResult> {
  const intentId = requireText(input.intentId, "GUEST_JOURNEY_FINANCIAL_OWNER_INTENT_ID_REQUIRED");
  const leaseToken = requireText(input.leaseToken, "GUEST_JOURNEY_FINANCIAL_OWNER_LEASE_TOKEN_REQUIRED");
  const now = requireDate(input.now ?? new Date(), "GUEST_JOURNEY_FINANCIAL_OWNER_NOW_INVALID");
  const leaseMs = requirePositive(input.leaseMs, "GUEST_JOURNEY_FINANCIAL_OWNER_LEASE_MS_INVALID");
  const maxClaims = requirePositive(input.maxClaims, "GUEST_JOURNEY_FINANCIAL_OWNER_MAX_CLAIMS_INVALID");

  return db.$transaction(async (tx) => {
    const intent = await tx.guestJourneyCoordinationIntent.findUnique({
      where: { id: intentId },
      select: intentSelect,
    });
    if (!intent) return { claimed: false, reason: "NOT_FOUND" } as const;
    assertContract(intent);

    const organizationId = intent.reservation.property.organizationId;
    const propertyId = intent.reservation.propertyId;
    if (!scopeAllows(organizationId, propertyId, input.scope)) {
      throw new Error("GUEST_JOURNEY_FINANCIAL_OWNER_SCOPE_MISMATCH");
    }

    const staleLease =
      intent.status === GuestJourneyCoordinationIntentStatus.CLAIMED &&
      Boolean(intent.leaseExpiresAt) &&
      intent.leaseExpiresAt!.getTime() <= now.getTime();
    if (intent.status === GuestJourneyCoordinationIntentStatus.CLAIMED && !staleLease) {
      return { claimed: false, reason: "LIVE_LEASE" } as const;
    }
    if (
      ![
        GuestJourneyCoordinationIntentStatus.PENDING,
        GuestJourneyCoordinationIntentStatus.RETRYABLE,
      ].includes(intent.status as never) &&
      !staleLease
    ) {
      return { claimed: false, reason: "NOT_ELIGIBLE" } as const;
    }
    if (!staleLease && intent.nextActionAt && intent.nextActionAt > now) {
      return { claimed: false, reason: "NOT_DUE" } as const;
    }

    if (staleLease) {
      if (!intent.leaseToken || !intent.claimedAt || !intent.leaseExpiresAt) {
        throw new Error("GUEST_JOURNEY_FINANCIAL_OWNER_STALE_LEASE_MALFORMED");
      }
      const expired = await tx.guestJourneyCoordinationIntentAttempt.updateMany({
        where: {
          intentId: intent.id,
          attemptNumber: intent.claimCount,
          outcome: GuestJourneyCoordinationAttemptOutcome.IN_FLIGHT,
          leaseExpiresAt: intent.leaseExpiresAt,
        },
        data: {
          outcome: GuestJourneyCoordinationAttemptOutcome.LEASE_EXPIRED,
          completedAt: now,
          errorCode: "FINANCIAL_OWNER_LEASE_EXPIRED",
          errorDetail: "The previous FINANCIAL owner did not complete before its fenced lease expired.",
        },
      });
      if (expired.count !== 1) {
        throw new Error("GUEST_JOURNEY_FINANCIAL_OWNER_STALE_ATTEMPT_EVIDENCE_MISSING");
      }
      await persistAuditEntry(tx, buildAudit({
        action: "LEASE_EXPIRED",
        intent: {
          id: intent.id,
          intentKey: intent.intentKey,
          reservationId: intent.reservationId,
          organizationId,
          propertyId,
        },
        attemptNumber: intent.claimCount,
        startedAt: intent.claimedAt,
        completedAt: now,
        inputFingerprint: intent.evidenceFingerprint,
        leaseFingerprint: tokenFingerprint(intent.leaseToken),
        errorCode: "FINANCIAL_OWNER_LEASE_EXPIRED",
      }));
    }

    if (intent.claimCount >= maxClaims) {
      const persisted = await exhaustIntent(
        tx,
        intent,
        now,
        "FINANCIAL_OWNER_CLAIM_BUDGET_EXHAUSTED",
        tokenFingerprint(intent.leaseToken ?? leaseToken)
      );
      return { claimed: false, reason: persisted ? "EXHAUSTED" : "CLAIM_RACE" } as const;
    }

    const attemptNumber = intent.claimCount + 1;
    const leaseExpiresAt = new Date(now.getTime() + leaseMs);
    const claimed = await tx.guestJourneyCoordinationIntent.updateMany({
      where: compareWhere(intent),
      data: {
        status: GuestJourneyCoordinationIntentStatus.CLAIMED,
        claimCount: attemptNumber,
        leaseToken,
        claimedAt: now,
        leaseExpiresAt,
        lastAttemptAt: now,
        nextActionAt: null,
        succeededAt: null,
        exhaustedAt: null,
        outcomeEvidenceFingerprint: null,
        lastError: null,
      },
    });
    if (claimed.count !== 1) return { claimed: false, reason: "CLAIM_RACE" } as const;

    const fingerprint = tokenFingerprint(leaseToken);
    await tx.guestJourneyCoordinationIntentAttempt.create({
      data: {
        intentId: intent.id,
        attemptNumber,
        targetEngine: "FINANCIAL",
        intentType: "REQUEST_PAYMENT_EVALUATION",
        handlerCode: GUEST_JOURNEY_PAYMENT_EVALUATION_HANDLER_CODE,
        leaseTokenFingerprint: fingerprint,
        inputEvidenceFingerprint: intent.evidenceFingerprint,
        outcome: GuestJourneyCoordinationAttemptOutcome.IN_FLIGHT,
        startedAt: now,
        leaseExpiresAt,
      },
    });
    await persistAuditEntry(tx, buildAudit({
      action: "CLAIMED",
      intent: {
        id: intent.id,
        intentKey: intent.intentKey,
        reservationId: intent.reservationId,
        organizationId,
        propertyId,
      },
      attemptNumber,
      startedAt: now,
      completedAt: now,
      inputFingerprint: intent.evidenceFingerprint,
      leaseFingerprint: fingerprint,
    }));

    return {
      claimed: true,
      recoveredStaleLease: staleLease,
      claim: {
        intentId: intent.id,
        intentKey: intent.intentKey,
        reservationId: intent.reservationId,
        journeyId: intent.journeyId,
        organizationId,
        propertyId,
        targetEngine: "FINANCIAL",
        intentType: "REQUEST_PAYMENT_EVALUATION",
        expectedOutcomeCode: "PAYMENT_STATE_RESOLVED",
        inputEvidenceFingerprint: intent.evidenceFingerprint,
        attemptNumber,
        leaseToken,
        leaseExpiresAt,
      },
    } as const;
  }, { isolationLevel: "Serializable" });
}

export async function completeGuestJourneyFinancialIntent(
  db: FinancialOwnerRuntimeDb,
  input: {
    claim: ClaimedFinancialIntent;
    completion: FinancialOwnerCompletion;
    maxClaims: number;
    retryBaseMs: number;
    now?: Date;
  }
): Promise<FinancialOwnerCompletionResult> {
  const now = requireDate(input.now ?? new Date(), "GUEST_JOURNEY_FINANCIAL_OWNER_COMPLETION_NOW_INVALID");
  const maxClaims = requirePositive(input.maxClaims, "GUEST_JOURNEY_FINANCIAL_OWNER_MAX_CLAIMS_INVALID");
  const retryBaseMs = requirePositive(input.retryBaseMs, "GUEST_JOURNEY_FINANCIAL_OWNER_RETRY_BASE_MS_INVALID");

  return db.$transaction(async (tx) => {
    const intent = await tx.guestJourneyCoordinationIntent.findUnique({
      where: { id: input.claim.intentId },
      select: intentSelect,
    });
    if (!intent) throw new Error("GUEST_JOURNEY_FINANCIAL_OWNER_COMPLETION_INTENT_NOT_FOUND");
    assertContract(intent);
    if (
      intent.reservationId !== input.claim.reservationId ||
      intent.reservation.propertyId !== input.claim.propertyId ||
      intent.reservation.property.organizationId !== input.claim.organizationId
    ) {
      throw new Error("GUEST_JOURNEY_FINANCIAL_OWNER_COMPLETION_SCOPE_MISMATCH");
    }
    if (
      intent.status !== GuestJourneyCoordinationIntentStatus.CLAIMED ||
      intent.claimCount !== input.claim.attemptNumber ||
      intent.leaseToken !== input.claim.leaseToken
    ) {
      throw new Error("GUEST_JOURNEY_FINANCIAL_OWNER_COMPLETION_LEASE_FENCE_LOST");
    }
    if (!intent.leaseExpiresAt || now.getTime() >= intent.leaseExpiresAt.getTime()) {
      throw new Error("GUEST_JOURNEY_FINANCIAL_OWNER_COMPLETION_LEASE_EXPIRED");
    }

    const finalFailure =
      input.completion.kind === "EXHAUSTED" ||
      (input.completion.kind === "RETRYABLE" && intent.claimCount >= maxClaims);
    const status = input.completion.kind === "SUCCEEDED"
      ? GuestJourneyCoordinationIntentStatus.SUCCEEDED
      : finalFailure
        ? GuestJourneyCoordinationIntentStatus.EXHAUSTED
        : input.completion.kind === "WAITING_FOR_EVIDENCE"
          ? GuestJourneyCoordinationIntentStatus.WAITING_FOR_EVIDENCE
          : GuestJourneyCoordinationIntentStatus.RETRYABLE;
    const retryDelay = Math.min(
      retryBaseMs * 2 ** Math.max(0, intent.claimCount - 1),
      MAX_RETRY_DELAY_MS
    );
    const suggestedRetryAt = input.completion.kind === "RETRYABLE"
      ? input.completion.retryAt ?? null
      : null;
    const calculatedRetryAt = new Date(now.getTime() + retryDelay);
    const nextActionAt = status === GuestJourneyCoordinationIntentStatus.RETRYABLE
      ? suggestedRetryAt && suggestedRetryAt > calculatedRetryAt
        ? suggestedRetryAt
        : calculatedRetryAt
      : null;
    const outputFingerprint = input.completion.outcomeEvidenceFingerprint ?? null;
    const errorCode = input.completion.kind === "SUCCEEDED" ? null : input.completion.errorCode;
    const errorDetail = input.completion.kind === "SUCCEEDED" ? null : input.completion.errorDetail;

    const updated = await tx.guestJourneyCoordinationIntent.updateMany({
      where: {
        id: intent.id,
        status: GuestJourneyCoordinationIntentStatus.CLAIMED,
        claimCount: intent.claimCount,
        leaseToken: input.claim.leaseToken,
        leaseExpiresAt: intent.leaseExpiresAt,
      },
      data: {
        status,
        leaseToken: null,
        claimedAt: null,
        leaseExpiresAt: null,
        nextActionAt,
        succeededAt: status === GuestJourneyCoordinationIntentStatus.SUCCEEDED ? now : null,
        exhaustedAt: status === GuestJourneyCoordinationIntentStatus.EXHAUSTED ? now : null,
        outcomeEvidenceFingerprint: outputFingerprint,
        lastError: errorCode,
      },
    });
    if (updated.count !== 1) {
      throw new Error("GUEST_JOURNEY_FINANCIAL_OWNER_COMPLETION_COMPARE_AND_SET_LOST");
    }

    const attemptOutcome = status === GuestJourneyCoordinationIntentStatus.SUCCEEDED
      ? GuestJourneyCoordinationAttemptOutcome.SUCCEEDED
      : status === GuestJourneyCoordinationIntentStatus.EXHAUSTED
        ? GuestJourneyCoordinationAttemptOutcome.EXHAUSTED
        : status === GuestJourneyCoordinationIntentStatus.WAITING_FOR_EVIDENCE
          ? GuestJourneyCoordinationAttemptOutcome.WAITING_FOR_EVIDENCE
          : GuestJourneyCoordinationAttemptOutcome.RETRYABLE;
    const attempt = await tx.guestJourneyCoordinationIntentAttempt.updateMany({
      where: {
        intentId: intent.id,
        attemptNumber: intent.claimCount,
        outcome: GuestJourneyCoordinationAttemptOutcome.IN_FLIGHT,
        leaseTokenFingerprint: tokenFingerprint(input.claim.leaseToken),
      },
      data: {
        outcome: attemptOutcome,
        completedAt: now,
        outcomeEvidenceFingerprint: outputFingerprint,
        errorCode,
        errorDetail,
      },
    });
    if (attempt.count !== 1) {
      throw new Error("GUEST_JOURNEY_FINANCIAL_OWNER_ATTEMPT_EVIDENCE_MISSING");
    }

    const action = status === GuestJourneyCoordinationIntentStatus.SUCCEEDED
      ? "SUCCEEDED"
      : status === GuestJourneyCoordinationIntentStatus.EXHAUSTED
        ? "EXHAUSTED"
        : status === GuestJourneyCoordinationIntentStatus.WAITING_FOR_EVIDENCE
          ? "WAITING_FOR_EVIDENCE"
          : "RETRYABLE";
    await persistAuditEntry(tx, buildAudit({
      action,
      intent: {
        id: intent.id,
        intentKey: intent.intentKey,
        reservationId: intent.reservationId,
        organizationId: intent.reservation.property.organizationId,
        propertyId: intent.reservation.propertyId,
      },
      attemptNumber: intent.claimCount,
      startedAt: intent.claimedAt ?? now,
      completedAt: now,
      inputFingerprint: intent.evidenceFingerprint,
      outputFingerprint,
      leaseFingerprint: tokenFingerprint(input.claim.leaseToken),
      errorCode,
      paymentState: input.completion.paymentState,
      hostPayoutStatus: input.completion.hostPayoutStatus,
    }));

    return {
      intentId: intent.id,
      attemptNumber: intent.claimCount,
      status: action,
      nextActionAt,
    };
  }, { isolationLevel: "Serializable" });
}

export type GuestJourneyFinancialOwnerRuntimePrisma = PrismaClient;
