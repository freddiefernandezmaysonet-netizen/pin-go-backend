import assert from "node:assert/strict";
import test from "node:test";

import {
  GuestJourneyCoordinationIntentStatus,
  type Prisma,
  type PrismaClient,
} from "@prisma/client";

import {
  claimGuestJourneyComplianceIntent,
  normalizeComplianceOwnerError,
  type ComplianceOwnerRuntimeDb,
} from "./guest-journey-compliance-owner-runtime.service";

function dbWithIntent(intent: any): ComplianceOwnerRuntimeDb {
  const tx = {
    guestJourneyCoordinationIntent: {
      findUnique: async () => intent,
      updateMany: async () => ({ count: 0 }),
    },
    guestJourneyCoordinationIntentAttempt: {
      updateMany: async () => ({ count: 0 }),
      create: async () => ({}),
    },
    apmsAuditEntry: {
      findUnique: async () => null,
      create: async () => ({}),
    },
  };
  return {
    $transaction: async <T>(
      callback: (tx: Prisma.TransactionClient) => Promise<T>
    ) => callback(tx as never),
  } as unknown as PrismaClient as ComplianceOwnerRuntimeDb;
}

function baseIntent(input: Partial<any> = {}) {
  return {
    id: "intent-1",
    intentKey: "intent-key",
    reservationId: "reservation-1",
    journeyId: "journey-1",
    targetEngine: "COMPLIANCE",
    intentType: "REQUEST_REQUIREMENTS_SNAPSHOT",
    expectedOutcomeCode: "REQUIREMENTS_SNAPSHOTS_PRESENT",
    evidenceFingerprint: "fingerprint-1",
    status: GuestJourneyCoordinationIntentStatus.PENDING,
    claimCount: 0,
    leaseToken: null,
    claimedAt: null,
    leaseExpiresAt: null,
    nextActionAt: null,
    reservation: {
      propertyId: "property-1",
      property: { organizationId: "org-1" },
    },
    ...input,
  };
}

test("E10 Compliance Owner redacts sensitive error details", () => {
  const normalized = normalizeComplianceOwnerError(
    new Error("bad token=abc123 password=secret Bearer xyz")
  );
  assert.equal(normalized.code, "BAD_TOKEN_REDACTED_PASSWORD_REDACTED_BEARER_REDACTED");
  assert.doesNotMatch(normalized.detail, /abc123|secret|xyz/);
});

test("E10 Compliance Owner rejects unsupported contracts before claiming", async () => {
  await assert.rejects(
    claimGuestJourneyComplianceIntent(
      dbWithIntent(baseIntent({
        targetEngine: "ACCESS",
        intentType: "REQUEST_ACCESS_PROVISIONING",
        expectedOutcomeCode: "SECURE_GUEST_ACCESS_ACTIVE",
      })),
      {
        intentId: "intent-1",
        leaseToken: "lease-token",
        scope: { organizationIds: ["org-1"], propertyIds: [] },
        leaseMs: 60_000,
        maxClaims: 3,
        now: new Date("2026-08-24T13:00:00.000Z"),
      }
    ),
    /COMPLIANCE_OWNER_HANDLER_CONTRACT_MISMATCH/
  );
});

test("E10 Compliance Owner fences canary scope", async () => {
  await assert.rejects(
    claimGuestJourneyComplianceIntent(
      dbWithIntent(baseIntent()),
      {
        intentId: "intent-1",
        leaseToken: "lease-token",
        scope: { organizationIds: ["org-x"], propertyIds: [] },
        leaseMs: 60_000,
        maxClaims: 3,
        now: new Date("2026-08-24T13:00:00.000Z"),
      }
    ),
    /COMPLIANCE_OWNER_SCOPE_MISMATCH/
  );
});
