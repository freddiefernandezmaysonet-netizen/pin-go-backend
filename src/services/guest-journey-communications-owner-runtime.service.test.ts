import assert from "node:assert/strict";
import test from "node:test";

import {
  GuestJourneyCoordinationAttemptOutcome,
  GuestJourneyCoordinationIntentStatus,
} from "@prisma/client";

import {
  claimGuestJourneyCommunicationIntent,
  completeGuestJourneyCommunicationIntent,
  type CommunicationsRuntimeDb,
} from "./guest-journey-communications-owner-runtime.service";

function createDb() {
  const intent: any = {
    id: "intent-1",
    intentKey: "key-1",
    reservationId: "reservation-1",
    journeyId: "journey-1",
    intentType: "REQUEST_COMMUNICATION_RETRY",
    targetEngine: "COMMUNICATIONS",
    expectedOutcomeCode: "COMMUNICATION_DELIVERY_FINAL",
    evidenceFingerprint: "evidence-1",
    payload: {
      messageLogId: "message-1",
      communicationType: "PRECHECKIN",
      channel: "sms",
    },
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
      key === "id" ? value === intent.id : (intent as any)[key] === value
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
  const db: CommunicationsRuntimeDb = {
    $transaction: async (callback) => callback(tx),
  };
  return { db, intent, attempts, audits };
}

const scope = { organizationIds: ["org-1"], propertyIds: [] };
const firstNow = new Date("2026-08-23T05:00:00.000Z");

test("claims exactly once with a durable lease and attempt evidence", async () => {
  const fixture = createDb();
  const first = await claimGuestJourneyCommunicationIntent(fixture.db, {
    intentId: "intent-1",
    leaseToken: "lease-1",
    scope,
    leaseMs: 60_000,
    maxClaims: 3,
    now: firstNow,
  });
  assert.equal(first.claimed, true);
  assert.equal(fixture.intent.status, GuestJourneyCoordinationIntentStatus.CLAIMED);
  assert.equal(fixture.intent.claimCount, 1);
  assert.equal(fixture.attempts.length, 1);
  assert.equal(fixture.attempts[0].outcome, GuestJourneyCoordinationAttemptOutcome.IN_FLIGHT);

  const duplicate = await claimGuestJourneyCommunicationIntent(fixture.db, {
    intentId: "intent-1",
    leaseToken: "lease-duplicate",
    scope,
    leaseMs: 60_000,
    maxClaims: 3,
    now: new Date(firstNow.getTime() + 1_000),
  });
  assert.deepEqual(duplicate, { claimed: false, reason: "LIVE_LEASE" });
  assert.equal(fixture.attempts.length, 1);
});

test("retry completion is fenced, exponentially scheduled, and later succeeds", async () => {
  const fixture = createDb();
  const claimed = await claimGuestJourneyCommunicationIntent(fixture.db, {
    intentId: "intent-1",
    leaseToken: "lease-1",
    scope,
    leaseMs: 60_000,
    maxClaims: 3,
    now: firstNow,
  });
  assert.equal(claimed.claimed, true);
  if (!claimed.claimed) return;

  const retry = await completeGuestJourneyCommunicationIntent(fixture.db, {
    claim: claimed.claim,
    completion: {
      kind: "RETRYABLE",
      errorCode: "TWILIO_TEMPORARY",
      errorDetail: "temporary provider failure",
      messageLogId: "message-1",
      communicationType: "PRECHECKIN",
      channel: "sms",
    },
    maxClaims: 3,
    retryBaseMs: 30_000,
    now: firstNow,
  });
  assert.equal(retry.status, "RETRYABLE");
  assert.equal(retry.nextActionAt?.toISOString(), "2026-08-23T05:00:30.000Z");
  assert.equal(fixture.attempts[0].outcome, GuestJourneyCoordinationAttemptOutcome.RETRYABLE);

  const second = await claimGuestJourneyCommunicationIntent(fixture.db, {
    intentId: "intent-1",
    leaseToken: "lease-2",
    scope,
    leaseMs: 60_000,
    maxClaims: 3,
    now: new Date("2026-08-23T05:00:30.000Z"),
  });
  assert.equal(second.claimed, true);
  if (!second.claimed) return;
  const success = await completeGuestJourneyCommunicationIntent(fixture.db, {
    claim: second.claim,
    completion: {
      kind: "SUCCEEDED",
      outcomeEvidenceFingerprint: "delivery-evidence",
      messageLogId: "message-1",
      communicationType: "PRECHECKIN",
      channel: "sms",
      deliveryStatus: "SENT",
    },
    maxClaims: 3,
    retryBaseMs: 30_000,
    now: new Date("2026-08-23T05:00:31.000Z"),
  });
  assert.equal(success.status, "SUCCEEDED");
  assert.equal(fixture.intent.status, GuestJourneyCoordinationIntentStatus.SUCCEEDED);
  assert.equal(fixture.intent.leaseToken, null);
});

test("a stale lease records expiration before a new fenced claim", async () => {
  const fixture = createDb();
  const first = await claimGuestJourneyCommunicationIntent(fixture.db, {
    intentId: "intent-1",
    leaseToken: "lease-1",
    scope,
    leaseMs: 5_000,
    maxClaims: 3,
    now: firstNow,
  });
  assert.equal(first.claimed, true);
  const recovered = await claimGuestJourneyCommunicationIntent(fixture.db, {
    intentId: "intent-1",
    leaseToken: "lease-2",
    scope,
    leaseMs: 5_000,
    maxClaims: 3,
    now: new Date(firstNow.getTime() + 5_001),
  });
  assert.equal(recovered.claimed, true);
  if (recovered.claimed) assert.equal(recovered.recoveredStaleLease, true);
  assert.equal(fixture.attempts[0].outcome, GuestJourneyCoordinationAttemptOutcome.LEASE_EXPIRED);
  assert.equal(fixture.attempts.length, 2);
});

test("tenant scope mismatch fails closed before claiming", async () => {
  const fixture = createDb();
  await assert.rejects(
    claimGuestJourneyCommunicationIntent(fixture.db, {
      intentId: "intent-1",
      leaseToken: "lease-1",
      scope: { organizationIds: ["other-org"], propertyIds: [] },
      leaseMs: 60_000,
      maxClaims: 3,
      now: firstNow,
    }),
    /COMMUNICATIONS_SCOPE_MISMATCH/
  );
  assert.equal(fixture.intent.claimCount, 0);
});

test("completion at the exact lease boundary is rejected without terminal writes", async () => {
  const fixture = createDb();
  const claimed = await claimGuestJourneyCommunicationIntent(fixture.db, {
    intentId: "intent-1",
    leaseToken: "lease-boundary",
    scope,
    leaseMs: 5_000,
    maxClaims: 3,
    now: firstNow,
  });
  assert.equal(claimed.claimed, true);
  if (!claimed.claimed) return;
  await assert.rejects(
    completeGuestJourneyCommunicationIntent(fixture.db, {
      claim: claimed.claim,
      completion: {
        kind: "SUCCEEDED",
        outcomeEvidenceFingerprint: "delivery-evidence",
        messageLogId: "message-1",
        communicationType: "PRECHECKIN",
        channel: "sms",
        deliveryStatus: "SENT",
      },
      maxClaims: 3,
      retryBaseMs: 30_000,
      now: new Date(firstNow.getTime() + 5_000),
    }),
    /COMPLETION_LEASE_EXPIRED/
  );
  assert.equal(fixture.intent.status, GuestJourneyCoordinationIntentStatus.CLAIMED);
  assert.equal(fixture.attempts[0].outcome, GuestJourneyCoordinationAttemptOutcome.IN_FLIGHT);
});

test("the final retry exhausts the budget with immutable error evidence", async () => {
  const fixture = createDb();
  fixture.intent.claimCount = 1;
  const claimed = await claimGuestJourneyCommunicationIntent(fixture.db, {
    intentId: "intent-1",
    leaseToken: "lease-final",
    scope,
    leaseMs: 60_000,
    maxClaims: 2,
    now: firstNow,
  });
  assert.equal(claimed.claimed, true);
  if (!claimed.claimed) return;
  const result = await completeGuestJourneyCommunicationIntent(fixture.db, {
    claim: claimed.claim,
    completion: {
      kind: "RETRYABLE",
      errorCode: "PROVIDER_DOWN",
      errorDetail: "provider unavailable",
      messageLogId: "message-1",
      communicationType: "PRECHECKIN",
      channel: "sms",
    },
    maxClaims: 2,
    retryBaseMs: 30_000,
    now: firstNow,
  });
  assert.equal(result.status, "EXHAUSTED");
  assert.equal(fixture.intent.status, GuestJourneyCoordinationIntentStatus.EXHAUSTED);
  assert.equal(fixture.intent.lastError, "PROVIDER_DOWN");
});
