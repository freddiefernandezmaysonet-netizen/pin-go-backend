import { createHash } from "node:crypto";

import {
  GuestJourneyCoordinationAttemptOutcome,
  GuestJourneyCoordinationIntentStatus,
  Prisma,
  PrismaClient,
} from "@prisma/client";

import { persistAuditEntry } from "../apms/audit-persistence.service";
import type { AuditEntry } from "../apms/audit-types";
import {
  GUEST_JOURNEY_COMMUNICATIONS_HANDLER_CODE,
  GUEST_JOURNEY_COMMUNICATIONS_OWNER_VERSION,
} from "./guest-journey-contract";

const MAX_RETRY_DELAY_MS = 60 * 60_000;

type RuntimeTx = Pick<
  Prisma.TransactionClient,
  | "guestJourneyCoordinationIntent"
  | "guestJourneyCoordinationIntentAttempt"
  | "apmsAuditEntry"
>;

export type CommunicationsRuntimeDb = {
  $transaction<T>(
    callback: (tx: RuntimeTx) => Promise<T>,
    options?: { isolationLevel?: "Serializable" }
  ): Promise<T>;
};

export type CommunicationsOwnerScope = {
  organizationIds: string[];
  propertyIds: string[];
};

export type ClaimedCommunicationIntent = {
  intentId: string;
  intentKey: string;
  reservationId: string;
  journeyId: string;
  organizationId: string;
  propertyId: string;
  targetEngine: "COMMUNICATIONS";
  intentType: "REQUEST_COMMUNICATION" | "REQUEST_COMMUNICATION_RETRY";
  expectedOutcomeCode: string;
  payload: Record<string, unknown>;
  inputEvidenceFingerprint: string;
  attemptNumber: number;
  leaseToken: string;
  leaseExpiresAt: Date;
};

export type CommunicationCompletion =
  | {
      kind: "SUCCEEDED";
      outcomeEvidenceFingerprint: string;
      messageLogId: string;
      communicationType: string;
      channel: string;
      deliveryStatus: "SENT" | "OBSOLETE";
    }
  | {
      kind: "WAITING_FOR_EVIDENCE" | "RETRYABLE";
      outcomeEvidenceFingerprint?: string;
      errorCode: string;
      errorDetail: string;
      messageLogId?: string | null;
      communicationType?: string | null;
      channel?: string | null;
    };

export type ClaimCommunicationIntentResult =
  | {
      claimed: true;
      recoveredStaleLease: boolean;
      claim: ClaimedCommunicationIntent;
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

export type CommunicationCompletionResult = {
  intentId: string;
  attemptNumber: number;
  status: "SUCCEEDED" | "WAITING_FOR_EVIDENCE" | "RETRYABLE" | "EXHAUSTED";
  nextActionAt: Date | null;
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

function normalizePayload(value: Prisma.JsonValue | null): Record<string, unknown> {
  if (!value || Array.isArray(value) || typeof value !== "object") return {};
  return value as Record<string, unknown>;
}

function scopeAllows(
  organizationId: string,
  propertyId: string,
  scope: CommunicationsOwnerScope
): boolean {
  return scope.organizationIds.includes(organizationId) ||
    scope.propertyIds.includes(propertyId);
}

export function normalizeCommunicationsOwnerError(error: unknown): {
  code: string;
  detail: string;
} {
  const raw = error instanceof Error ? error.message : String(error);
  const code = raw
    .split(":", 1)[0]
    .trim()
    .replace(/[^A-Z0-9_]/gi, "_")
    .toUpperCase() || "UNKNOWN_ERROR";
  const detail = raw
    .replace(/:\/\/[^\s/@:]+:[^\s/@]+@/g, "://[REDACTED]@")
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [REDACTED]")
    .replace(/\b(password|secret|token|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .slice(0, 8_000);
  return { code, detail };
}

function assertContract(intent: {
  targetEngine: string;
  intentType: string;
  expectedOutcomeCode: string;
}): void {
  if (
    intent.targetEngine !== "COMMUNICATIONS" ||
    !["REQUEST_COMMUNICATION", "REQUEST_COMMUNICATION_RETRY"].includes(
      intent.intentType
    ) ||
    intent.expectedOutcomeCode !== "COMMUNICATION_DELIVERY_FINAL"
  ) {
    throw new Error("GUEST_JOURNEY_COMMUNICATIONS_HANDLER_CONTRACT_MISMATCH");
  }
}

function buildAudit(input: {
  action: "CLAIMED" | "LEASE_EXPIRED" | "SUCCEEDED" | "WAITING_FOR_EVIDENCE" | "RETRYABLE" | "EXHAUSTED";
  intentId: string;
  intentKey: string;
  reservationId: string;
  organizationId: string;
  propertyId: string;
  attemptNumber: number;
  startedAt: Date;
  completedAt: Date;
  inputFingerprint: string;
  outputFingerprint?: string | null;
  leaseFingerprint: string;
  errorCode?: string | null;
  messageLogId?: string | null;
  communicationType?: string | null;
  channel?: string | null;
}): AuditEntry {
  const success = ["CLAIMED", "SUCCEEDED", "WAITING_FOR_EVIDENCE"].includes(input.action);
  return {
    engine: "COMMUNICATIONS",
    decisionId: `guest-journey:communications:${input.intentId}:${input.attemptNumber}:${input.action.toLowerCase()}`,
    entityType: "RESERVATION",
    entityId: input.reservationId,
    eventType: input.action === "CLAIMED" ? "ACTION_STARTED" : success ? "ACTION_COMPLETED" : "ACTION_FAILED",
    status: success ? "SUCCESS" : "FAILED",
    severity: input.action === "EXHAUSTED" ? "CRITICAL" : ["RETRYABLE", "LEASE_EXPIRED"].includes(input.action) ? "WARNING" : "INFO",
    summary: `Guest Journey COMMUNICATIONS attempt ${input.attemptNumber} ${input.action.toLowerCase().replaceAll("_", " ")}.`,
    reason: input.errorCode ?? "The canonical communication transition was fenced and persisted.",
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    durationMs: Math.max(0, input.completedAt.getTime() - input.startedAt.getTime()),
    metadata: {
      runtime: GUEST_JOURNEY_COMMUNICATIONS_OWNER_VERSION,
      handlerCode: GUEST_JOURNEY_COMMUNICATIONS_HANDLER_CODE,
      intentId: input.intentId,
      intentKey: input.intentKey,
      attemptNumber: input.attemptNumber,
      organizationId: input.organizationId,
      propertyId: input.propertyId,
      reservationId: input.reservationId,
      messageLogId: input.messageLogId ?? null,
      communicationType: input.communicationType ?? null,
      channel: input.channel ?? null,
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
  payload: true,
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
    intentId: intent.id,
    intentKey: intent.intentKey,
    reservationId: intent.reservationId,
    organizationId: intent.reservation.property.organizationId,
    propertyId: intent.reservation.propertyId,
    attemptNumber: Math.max(1, intent.claimCount),
    startedAt: intent.claimedAt ?? now,
    completedAt: now,
    inputFingerprint: intent.evidenceFingerprint,
    leaseFingerprint,
    errorCode,
  }));
  return true;
}

export async function claimGuestJourneyCommunicationIntent(
  db: CommunicationsRuntimeDb,
  input: {
    intentId: string;
    leaseToken: string;
    scope: CommunicationsOwnerScope;
    leaseMs: number;
    maxClaims: number;
    now?: Date;
  }
): Promise<ClaimCommunicationIntentResult> {
  const intentId = requireText(input.intentId, "GUEST_JOURNEY_COMMUNICATIONS_INTENT_ID_REQUIRED");
  const leaseToken = requireText(input.leaseToken, "GUEST_JOURNEY_COMMUNICATIONS_LEASE_TOKEN_REQUIRED");
  const now = requireDate(input.now ?? new Date(), "GUEST_JOURNEY_COMMUNICATIONS_NOW_INVALID");
  const leaseMs = requirePositive(input.leaseMs, "GUEST_JOURNEY_COMMUNICATIONS_LEASE_MS_INVALID");
  const maxClaims = requirePositive(input.maxClaims, "GUEST_JOURNEY_COMMUNICATIONS_MAX_CLAIMS_INVALID");

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
      throw new Error("GUEST_JOURNEY_COMMUNICATIONS_SCOPE_MISMATCH");
    }

    const staleLease = intent.status === GuestJourneyCoordinationIntentStatus.CLAIMED &&
      Boolean(intent.leaseExpiresAt) && intent.leaseExpiresAt!.getTime() <= now.getTime();
    if (intent.status === GuestJourneyCoordinationIntentStatus.CLAIMED && !staleLease) {
      return { claimed: false, reason: "LIVE_LEASE" } as const;
    }
    if (![GuestJourneyCoordinationIntentStatus.PENDING, GuestJourneyCoordinationIntentStatus.RETRYABLE].includes(intent.status as never) && !staleLease) {
      return { claimed: false, reason: "NOT_ELIGIBLE" } as const;
    }
    if (!staleLease && intent.nextActionAt && intent.nextActionAt > now) {
      return { claimed: false, reason: "NOT_DUE" } as const;
    }

    if (staleLease) {
      if (!intent.leaseToken || !intent.claimedAt || !intent.leaseExpiresAt) {
        throw new Error("GUEST_JOURNEY_COMMUNICATIONS_STALE_LEASE_MALFORMED");
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
          errorCode: "COMMUNICATIONS_LEASE_EXPIRED",
          errorDetail: "The previous owner did not complete before its fenced lease expired.",
        },
      });
      if (expired.count !== 1) {
        throw new Error("GUEST_JOURNEY_COMMUNICATIONS_STALE_ATTEMPT_EVIDENCE_MISSING");
      }
      await persistAuditEntry(tx, buildAudit({
        action: "LEASE_EXPIRED",
        intentId: intent.id,
        intentKey: intent.intentKey,
        reservationId: intent.reservationId,
        organizationId,
        propertyId,
        attemptNumber: intent.claimCount,
        startedAt: intent.claimedAt,
        completedAt: now,
        inputFingerprint: intent.evidenceFingerprint,
        leaseFingerprint: tokenFingerprint(intent.leaseToken),
        errorCode: "COMMUNICATIONS_LEASE_EXPIRED",
      }));
    }

    if (intent.claimCount >= maxClaims) {
      const persisted = await exhaustIntent(
        tx,
        intent,
        now,
        "COMMUNICATIONS_CLAIM_BUDGET_EXHAUSTED",
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
        targetEngine: "COMMUNICATIONS",
        intentType: intent.intentType,
        handlerCode: GUEST_JOURNEY_COMMUNICATIONS_HANDLER_CODE,
        leaseTokenFingerprint: fingerprint,
        inputEvidenceFingerprint: intent.evidenceFingerprint,
        outcome: GuestJourneyCoordinationAttemptOutcome.IN_FLIGHT,
        startedAt: now,
        leaseExpiresAt,
      },
    });
    await persistAuditEntry(tx, buildAudit({
      action: "CLAIMED",
      intentId: intent.id,
      intentKey: intent.intentKey,
      reservationId: intent.reservationId,
      organizationId,
      propertyId,
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
        targetEngine: "COMMUNICATIONS",
        intentType: intent.intentType as ClaimedCommunicationIntent["intentType"],
        expectedOutcomeCode: intent.expectedOutcomeCode,
        payload: normalizePayload(intent.payload),
        inputEvidenceFingerprint: intent.evidenceFingerprint,
        attemptNumber,
        leaseToken,
        leaseExpiresAt,
      },
    } as const;
  }, { isolationLevel: "Serializable" });
}

export async function completeGuestJourneyCommunicationIntent(
  db: CommunicationsRuntimeDb,
  input: {
    claim: ClaimedCommunicationIntent;
    completion: CommunicationCompletion;
    maxClaims: number;
    retryBaseMs: number;
    now?: Date;
  }
): Promise<CommunicationCompletionResult> {
  const now = requireDate(input.now ?? new Date(), "GUEST_JOURNEY_COMMUNICATIONS_COMPLETION_NOW_INVALID");
  const maxClaims = requirePositive(input.maxClaims, "GUEST_JOURNEY_COMMUNICATIONS_MAX_CLAIMS_INVALID");
  const retryBaseMs = requirePositive(input.retryBaseMs, "GUEST_JOURNEY_COMMUNICATIONS_RETRY_BASE_MS_INVALID");

  return db.$transaction(async (tx) => {
    const intent = await tx.guestJourneyCoordinationIntent.findUnique({
      where: { id: input.claim.intentId },
      select: intentSelect,
    });
    if (!intent) throw new Error("GUEST_JOURNEY_COMMUNICATIONS_COMPLETION_INTENT_NOT_FOUND");
    assertContract(intent);
    if (
      intent.reservationId !== input.claim.reservationId ||
      intent.reservation.propertyId !== input.claim.propertyId ||
      intent.reservation.property.organizationId !== input.claim.organizationId
    ) throw new Error("GUEST_JOURNEY_COMMUNICATIONS_COMPLETION_SCOPE_MISMATCH");
    if (
      intent.status !== GuestJourneyCoordinationIntentStatus.CLAIMED ||
      intent.claimCount !== input.claim.attemptNumber ||
      intent.leaseToken !== input.claim.leaseToken
    ) throw new Error("GUEST_JOURNEY_COMMUNICATIONS_COMPLETION_LEASE_FENCE_LOST");
    if (
      !intent.leaseExpiresAt ||
      now.getTime() >= intent.leaseExpiresAt.getTime()
    ) {
      throw new Error("GUEST_JOURNEY_COMMUNICATIONS_COMPLETION_LEASE_EXPIRED");
    }

    const finalFailure = input.completion.kind === "RETRYABLE" && intent.claimCount >= maxClaims;
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
    const nextActionAt = status === GuestJourneyCoordinationIntentStatus.RETRYABLE
      ? new Date(now.getTime() + retryDelay)
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
    if (updated.count !== 1) throw new Error("GUEST_JOURNEY_COMMUNICATIONS_COMPLETION_COMPARE_AND_SET_LOST");

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
    if (attempt.count !== 1) throw new Error("GUEST_JOURNEY_COMMUNICATIONS_ATTEMPT_EVIDENCE_MISSING");

    const action = status === GuestJourneyCoordinationIntentStatus.SUCCEEDED
      ? "SUCCEEDED"
      : status === GuestJourneyCoordinationIntentStatus.EXHAUSTED
        ? "EXHAUSTED"
        : status === GuestJourneyCoordinationIntentStatus.WAITING_FOR_EVIDENCE
          ? "WAITING_FOR_EVIDENCE"
          : "RETRYABLE";
    await persistAuditEntry(tx, buildAudit({
      action,
      intentId: intent.id,
      intentKey: intent.intentKey,
      reservationId: intent.reservationId,
      organizationId: intent.reservation.property.organizationId,
      propertyId: intent.reservation.propertyId,
      attemptNumber: intent.claimCount,
      startedAt: intent.claimedAt ?? now,
      completedAt: now,
      inputFingerprint: intent.evidenceFingerprint,
      outputFingerprint,
      leaseFingerprint: tokenFingerprint(input.claim.leaseToken),
      errorCode,
      messageLogId: input.completion.messageLogId,
      communicationType: input.completion.communicationType,
      channel: input.completion.channel,
    }));

    return {
      intentId: intent.id,
      attemptNumber: intent.claimCount,
      status: action,
      nextActionAt,
    };
  }, { isolationLevel: "Serializable" });
}

export type GuestJourneyCommunicationsRuntimePrisma = PrismaClient;
