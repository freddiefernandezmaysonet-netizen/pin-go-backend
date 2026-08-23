import assert from "node:assert/strict";
import test from "node:test";

import {
  GuestJourneyCoordinationAttemptOutcome,
  GuestJourneyCoordinationIntentStatus,
} from "@prisma/client";

import {
  claimGuestJourneyAccessIntent,
  completeGuestJourneyAccessIntent,
  normalizeAccessOwnerError,
  type AccessOwnerRuntimeDb,
} from "./guest-journey-access-owner-runtime.service";

function createDb(input: {
  intentType?: "REQUEST_ACCESS_PROVISIONING" | "REQUEST_ACCESS_REVOCATION_CHECK";
  expectedOutcomeCode?: "SECURE_GUEST_ACCESS_ACTIVE" | "ALL_GUEST_ACCESS_CLOSED";
} = {}) {
  const intentType = input.intentType ?? "REQUEST_ACCESS_PROVISIONING";
  const intent: any = {
    id: "intent-1",
    intentKey: "key-1",
    reservationId: "reservation-1",
    journeyId: "journey-1",
    intentType,
    targetEngine: "ACCESS",
    expectedOutcomeCode: input.expectedOutcomeCode ??
      (intentType === "REQUEST_ACCESS_PROVISIONING"
        ? "SECURE_GUEST_ACCESS_ACTIVE"
        : "ALL_GUEST_ACCESS_CLOSED"),
    evidenceFingerprint: "evidence-1",
    status: GuestJourneyCoordinationIntentStatus.PENDING,
    claimCount: 0,
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
  const db: AccessOwnerRuntimeDb = {
    $transaction: async (callback) => callback(tx),
  };
  return { db, intent, attempts, audits };
}

const scope = { organizationIds: ["org-1"], propertyIds: [] };
const firstNow = new Date("2026-08-23T12:00:00.000Z");

test("E8 claims exactly once with a durable lease and typed handler evidence", async () => {
  const fixture = createDb();
  const result = await claimGuestJourneyAccessIntent(fixture.db, {
    intentId: "intent-1",
    leaseToken: "lease-1",
    scope,
    leaseMs: 60_000,
    maxClaims: 7,
    now: firstNow,
  });
  assert.equal(result.claimed, true);
  assert.equal(fixture.intent.status, GuestJourneyCoordinationIntentStatus.CLAIMED);
  assert.equal(fixture.attempts[0].handlerCode, "ACCESS_PROVISIONING_V1");
  assert.equal(fixture.attempts[0].outcome, GuestJourneyCoordinationAttemptOutcome.IN_FLIGHT);
  const duplicate = await claimGuestJourneyAccessIntent(fixture.db, {
    intentId: "intent-1",
    leaseToken: "lease-2",
    scope,
    leaseMs: 60_000,
    maxClaims: 7,
    now: new Date(firstNow.getTime() + 1_000),
  });
  assert.deepEqual(duplicate, { claimed: false, reason: "LIVE_LEASE" });
});

test("E8 uses the revocation handler only for the canonical revocation contract", async () => {
  const fixture = createDb({ intentType: "REQUEST_ACCESS_REVOCATION_CHECK" });
  const result = await claimGuestJourneyAccessIntent(fixture.db, {
    intentId: "intent-1",
    leaseToken: "lease-1",
    scope,
    leaseMs: 60_000,
    maxClaims: 7,
    now: firstNow,
  });
  assert.equal(result.claimed, true);
  assert.equal(fixture.attempts[0].handlerCode, "ACCESS_REVOCATION_CHECK_V1");
});

test("E8 schedules retries no earlier than canonical recovery evidence", async () => {
  const fixture = createDb();
  const claimed = await claimGuestJourneyAccessIntent(fixture.db, {
    intentId: "intent-1",
    leaseToken: "lease-1",
    scope,
    leaseMs: 60_000,
    maxClaims: 7,
    now: firstNow,
  });
  assert.equal(claimed.claimed, true);
  if (!claimed.claimed) return;
  const retryAt = new Date(firstNow.getTime() + 5 * 60_000);
  const result = await completeGuestJourneyAccessIntent(fixture.db, {
    claim: claimed.claim,
    completion: {
      kind: "RETRYABLE",
      errorCode: "ACCESS_RECOVERY_NOT_DUE",
      errorDetail: "backoff",
      retryAt,
      accessGrantIds: ["grant-1"],
    },
    maxClaims: 7,
    retryBaseMs: 60_000,
    now: firstNow,
  });
  assert.equal(result.status, "RETRYABLE");
  assert.equal(result.nextActionAt?.toISOString(), retryAt.toISOString());
  assert.equal(fixture.attempts[0].outcome, GuestJourneyCoordinationAttemptOutcome.RETRYABLE);
});

test("E8 immediately exhausts an ambiguous hardware result to prevent replay", async () => {
  const fixture = createDb();
  const claimed = await claimGuestJourneyAccessIntent(fixture.db, {
    intentId: "intent-1",
    leaseToken: "lease-1",
    scope,
    leaseMs: 60_000,
    maxClaims: 7,
    now: firstNow,
  });
  assert.equal(claimed.claimed, true);
  if (!claimed.claimed) return;
  const result = await completeGuestJourneyAccessIntent(fixture.db, {
    claim: claimed.claim,
    completion: {
      kind: "AMBIGUOUS",
      errorCode: "ACCESS_PROVIDER_RESULT_AMBIGUOUS",
      errorDetail: "timeout after dispatch",
      accessGrantIds: ["grant-1"],
    },
    maxClaims: 7,
    retryBaseMs: 60_000,
    now: firstNow,
  });
  assert.equal(result.status, "EXHAUSTED");
  assert.equal(result.nextActionAt, null);
  assert.equal(fixture.intent.status, GuestJourneyCoordinationIntentStatus.EXHAUSTED);
  assert.equal(fixture.attempts[0].outcome, GuestJourneyCoordinationAttemptOutcome.EXHAUSTED);
});

test("E8 records stale lease expiration before a fenced reclaim", async () => {
  const fixture = createDb();
  await claimGuestJourneyAccessIntent(fixture.db, {
    intentId: "intent-1",
    leaseToken: "lease-1",
    scope,
    leaseMs: 5_000,
    maxClaims: 7,
    now: firstNow,
  });
  const recovered = await claimGuestJourneyAccessIntent(fixture.db, {
    intentId: "intent-1",
    leaseToken: "lease-2",
    scope,
    leaseMs: 5_000,
    maxClaims: 7,
    now: new Date(firstNow.getTime() + 5_001),
  });
  assert.equal(recovered.claimed, true);
  if (recovered.claimed) assert.equal(recovered.recoveredStaleLease, true);
  assert.equal(fixture.attempts[0].outcome, GuestJourneyCoordinationAttemptOutcome.LEASE_EXPIRED);
  assert.equal(fixture.attempts.length, 2);
});

test("E8 fails closed on tenant scope drift and exact lease expiry", async () => {
  const fixture = createDb();
  await assert.rejects(
    claimGuestJourneyAccessIntent(fixture.db, {
      intentId: "intent-1",
      leaseToken: "lease-1",
      scope: { organizationIds: ["other"], propertyIds: [] },
      leaseMs: 60_000,
      maxClaims: 7,
      now: firstNow,
    }),
    /ACCESS_OWNER_SCOPE_MISMATCH/
  );
  const claimed = await claimGuestJourneyAccessIntent(fixture.db, {
    intentId: "intent-1",
    leaseToken: "lease-2",
    scope,
    leaseMs: 5_000,
    maxClaims: 7,
    now: firstNow,
  });
  assert.equal(claimed.claimed, true);
  if (!claimed.claimed) return;
  await assert.rejects(
    completeGuestJourneyAccessIntent(fixture.db, {
      claim: claimed.claim,
      completion: {
        kind: "SUCCEEDED",
        action: "PROVISIONED",
        outcomeEvidenceFingerprint: "output",
        accessGrantIds: ["grant-1"],
      },
      maxClaims: 7,
      retryBaseMs: 60_000,
      now: new Date(firstNow.getTime() + 5_000),
    }),
    /COMPLETION_LEASE_EXPIRED/
  );
});

test("E8 redacts secrets from durable errors", () => {
  const normalized = normalizeAccessOwnerError(
    new Error("provider_failed: token=abc passcode=123456")
  );
  assert.equal(normalized.code, "PROVIDER_FAILED");
  assert.doesNotMatch(normalized.detail, /abc|123456/);
});
