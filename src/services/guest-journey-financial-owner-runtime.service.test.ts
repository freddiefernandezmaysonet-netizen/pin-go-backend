import assert from "node:assert/strict";
import test from "node:test";

import {
  GuestJourneyCoordinationAttemptOutcome,
  GuestJourneyCoordinationIntentStatus,
  PaymentState,
} from "@prisma/client";

import {
  claimGuestJourneyFinancialIntent,
  completeGuestJourneyFinancialIntent,
  normalizeFinancialOwnerError,
  type FinancialOwnerRuntimeDb,
} from "./guest-journey-financial-owner-runtime.service";

function createDb(input: {
  targetEngine?: string;
  intentType?: string;
  expectedOutcomeCode?: string;
  claimCount?: number;
} = {}) {
  const intent: any = {
    id: "intent-1",
    intentKey: "key-1",
    reservationId: "reservation-1",
    journeyId: "journey-1",
    intentType: input.intentType ?? "REQUEST_PAYMENT_EVALUATION",
    targetEngine: input.targetEngine ?? "FINANCIAL",
    expectedOutcomeCode: input.expectedOutcomeCode ?? "PAYMENT_STATE_RESOLVED",
    evidenceFingerprint: "evidence-1",
    status: GuestJourneyCoordinationIntentStatus.PENDING,
    claimCount: input.claimCount ?? 0,
    leaseToken: null,
    claimedAt: null,
    leaseExpiresAt: null,
    nextActionAt: null,
    succeededAt: null,
    exhaustedAt: null,
    outcomeEvidenceFingerprint: null,
    lastError: null,
    reservation: {
      propertyId: "property-1",
      property: { organizationId: "org-1" },
    },
  };
  const attempts: any[] = [];
  const audits: any[] = [];
  function matches(where: any) {
    return Object.entries(where).every(([key, value]) =>
      key === "id" ? value === intent.id : intent[key] === value
    );
  }
  const tx: any = {
    guestJourneyCoordinationIntent: {
      findUnique: async ({ where }: any) => where.id === intent.id ? { ...intent } : null,
      updateMany: async ({ where, data }: any) => {
        if (!matches(where)) return { count: 0 };
        Object.assign(intent, data);
        return { count: 1 };
      },
    },
    guestJourneyCoordinationIntentAttempt: {
      create: async ({ data }: any) => {
        attempts.push({ ...data, id: `attempt-${attempts.length + 1}` });
        return attempts.at(-1);
      },
      updateMany: async ({ where, data }: any) => {
        const attempt = attempts.find((candidate) =>
          candidate.intentId === where.intentId &&
          candidate.attemptNumber === where.attemptNumber &&
          candidate.outcome === where.outcome &&
          (where.leaseTokenFingerprint === undefined ||
            candidate.leaseTokenFingerprint === where.leaseTokenFingerprint) &&
          (where.leaseExpiresAt === undefined ||
            candidate.leaseExpiresAt === where.leaseExpiresAt)
        );
        if (!attempt) return { count: 0 };
        Object.assign(attempt, data);
        return { count: 1 };
      },
    },
    apmsAuditEntry: {
      findUnique: async ({ where }: any) =>
        audits.find((entry) => entry.decisionId === where.decisionId) ?? null,
      create: async ({ data }: any) => {
        audits.push({ ...data });
        return data;
      },
    },
  };
  const db: FinancialOwnerRuntimeDb = {
    $transaction: async (callback) => callback(tx),
  };
  return { db, intent, attempts, audits };
}

const scope = { organizationIds: ["org-1"], propertyIds: [] };
const firstNow = new Date("2026-08-24T12:00:00.000Z");

test("E9 claims exactly once with a durable FINANCIAL payment handler", async () => {
  const fixture = createDb();
  const result = await claimGuestJourneyFinancialIntent(fixture.db, {
    intentId: "intent-1",
    leaseToken: "lease-1",
    scope,
    leaseMs: 60_000,
    maxClaims: 3,
    now: firstNow,
  });
  assert.equal(result.claimed, true);
  assert.equal(fixture.intent.status, GuestJourneyCoordinationIntentStatus.CLAIMED);
  assert.equal(fixture.attempts[0].targetEngine, "FINANCIAL");
  assert.equal(fixture.attempts[0].intentType, "REQUEST_PAYMENT_EVALUATION");
  assert.equal(fixture.attempts[0].handlerCode, "PAYMENT_EVALUATION_V1");
  const duplicate = await claimGuestJourneyFinancialIntent(fixture.db, {
    intentId: "intent-1",
    leaseToken: "lease-2",
    scope,
    leaseMs: 60_000,
    maxClaims: 3,
    now: new Date(firstNow.getTime() + 1_000),
  });
  assert.deepEqual(duplicate, { claimed: false, reason: "LIVE_LEASE" });
});

test("E9 completes paid evidence without provider replay", async () => {
  const fixture = createDb();
  const claimed = await claimGuestJourneyFinancialIntent(fixture.db, {
    intentId: "intent-1",
    leaseToken: "lease-1",
    scope,
    leaseMs: 60_000,
    maxClaims: 3,
    now: firstNow,
  });
  assert.equal(claimed.claimed, true);
  if (!claimed.claimed) return;
  const result = await completeGuestJourneyFinancialIntent(fixture.db, {
    claim: claimed.claim,
    completion: {
      kind: "SUCCEEDED",
      action: "PAYMENT_ALREADY_SATISFIED",
      paymentState: PaymentState.PAID,
      hostPayoutStatus: "ROUTED_TO_CONNECT",
      outcomeEvidenceFingerprint: "output",
    },
    maxClaims: 3,
    retryBaseMs: 60_000,
    now: firstNow,
  });
  assert.equal(result.status, "SUCCEEDED");
  assert.equal(fixture.intent.status, GuestJourneyCoordinationIntentStatus.SUCCEEDED);
  assert.equal(fixture.attempts[0].outcome, GuestJourneyCoordinationAttemptOutcome.SUCCEEDED);
});

test("E9 waits for payment evidence without exhausting or charging", async () => {
  const fixture = createDb();
  const claimed = await claimGuestJourneyFinancialIntent(fixture.db, {
    intentId: "intent-1",
    leaseToken: "lease-1",
    scope,
    leaseMs: 60_000,
    maxClaims: 3,
    now: firstNow,
  });
  assert.equal(claimed.claimed, true);
  if (!claimed.claimed) return;
  const result = await completeGuestJourneyFinancialIntent(fixture.db, {
    claim: claimed.claim,
    completion: {
      kind: "WAITING_FOR_EVIDENCE",
      paymentState: PaymentState.NONE,
      errorCode: "PAYMENT_EVIDENCE_NOT_YET_SATISFIED",
      errorDetail: "wait",
    },
    maxClaims: 3,
    retryBaseMs: 60_000,
    now: firstNow,
  });
  assert.equal(result.status, "WAITING_FOR_EVIDENCE");
  assert.equal(fixture.intent.status, GuestJourneyCoordinationIntentStatus.WAITING_FOR_EVIDENCE);
});

test("E9 exhausts fenced financial inconsistencies for Mission Control", async () => {
  const fixture = createDb();
  const claimed = await claimGuestJourneyFinancialIntent(fixture.db, {
    intentId: "intent-1",
    leaseToken: "lease-1",
    scope,
    leaseMs: 60_000,
    maxClaims: 3,
    now: firstNow,
  });
  assert.equal(claimed.claimed, true);
  if (!claimed.claimed) return;
  const result = await completeGuestJourneyFinancialIntent(fixture.db, {
    claim: claimed.claim,
    completion: {
      kind: "EXHAUSTED",
      paymentState: PaymentState.PAID,
      errorCode: "FINANCIAL_DIRECT_BOOKING_STRIPE_EVIDENCE_INCOMPLETE",
      errorDetail: "missing refs",
    },
    maxClaims: 3,
    retryBaseMs: 60_000,
    now: firstNow,
  });
  assert.equal(result.status, "EXHAUSTED");
  assert.equal(fixture.intent.status, GuestJourneyCoordinationIntentStatus.EXHAUSTED);
});

test("E9 fails closed on scope and contract drift", async () => {
  await assert.rejects(
    claimGuestJourneyFinancialIntent(createDb().db, {
      intentId: "intent-1",
      leaseToken: "lease-1",
      scope: { organizationIds: ["other"], propertyIds: [] },
      leaseMs: 60_000,
      maxClaims: 3,
      now: firstNow,
    }),
    /FINANCIAL_OWNER_SCOPE_MISMATCH/
  );
  await assert.rejects(
    claimGuestJourneyFinancialIntent(
      createDb({ targetEngine: "ACCESS" }).db,
      {
        intentId: "intent-1",
        leaseToken: "lease-1",
        scope,
        leaseMs: 60_000,
        maxClaims: 3,
        now: firstNow,
      }
    ),
    /FINANCIAL_OWNER_HANDLER_CONTRACT_MISMATCH/
  );
});

test("E9 redacts provider-like secrets in normalized errors", () => {
  const normalized = normalizeFinancialOwnerError(
    new Error("stripe failure token=sk_test_123 payment_intent=pi_123")
  );
  assert.equal(normalized.code, "STRIPE_FAILURE_TOKEN_REDACTED_PAYMENT_INTENT_REDACTED");
  assert.doesNotMatch(normalized.detail, /sk_test_123|pi_123/);
});
