import assert from "node:assert/strict";
import test from "node:test";

import { Prisma, PrismaClient } from "@prisma/client";

import {
  claimGuestJourneyAccessEvaluationIntent,
  type GuestJourneyOwnerRuntimeDb,
} from "./guest-journey-owner-runtime.service";
import {
  claimGuestJourneyCommunicationIntent,
  type CommunicationsRuntimeDb,
} from "./guest-journey-communications-owner-runtime.service";
import {
  claimGuestJourneyAccessIntent,
  type AccessOwnerRuntimeDb,
} from "./guest-journey-access-owner-runtime.service";
import {
  claimGuestJourneyFinancialIntent,
  type FinancialOwnerRuntimeDb,
} from "./guest-journey-financial-owner-runtime.service";
import {
  claimGuestJourneyComplianceIntent,
  type ComplianceOwnerRuntimeDb,
} from "./guest-journey-compliance-owner-runtime.service";

const prisma = new PrismaClient();

const TARGET_CHECK_NAME =
  "GuestJourneyCoordinationIntentAttempt_target_check";

const invalidCombinations = [
  ["FINANCIAL", "REQUEST_PAYMENT_EVALUATION", "ACCESS_EVALUATION_V1"],
  ["COMPLIANCE", "REQUEST_PAYMENT_EVALUATION", "PAYMENT_EVALUATION_V1"],
  ["ACCESS", "REQUEST_ACCESS_PROVISIONING", "UNKNOWN_HANDLER"],
  ["COMMUNICATIONS", "UNKNOWN_INTENT", "COMMUNICATION_RETRY_V1"],
  ["UNKNOWN_ENGINE", "REQUEST_PAYMENT_EVALUATION", "PAYMENT_EVALUATION_V1"],
] as const;

type RuntimeScope = {
  organizationIds: string[];
  propertyIds: string[];
};

type RuntimeCase = {
  label: string;
  targetEngine: string;
  intentType: string;
  expectedOutcomeCode: string;
  expectedHandlerCode: string;
  claim: (
    intentId: string,
    leaseToken: string,
    scope: RuntimeScope,
    now: Date
  ) => Promise<{ claimed: boolean }>;
};

const ownerRuntimeDb = prisma as unknown as GuestJourneyOwnerRuntimeDb;
const communicationsRuntimeDb = prisma as unknown as CommunicationsRuntimeDb;
const accessOwnerRuntimeDb = prisma as unknown as AccessOwnerRuntimeDb;
const financialOwnerRuntimeDb = prisma as unknown as FinancialOwnerRuntimeDb;
const complianceOwnerRuntimeDb = prisma as unknown as ComplianceOwnerRuntimeDb;

const runtimeCases: RuntimeCase[] = [
  {
    label: "E5 ACCESS evaluation",
    targetEngine: "ACCESS",
    intentType: "REQUEST_ACCESS_EVALUATION",
    expectedOutcomeCode: "ACCESS_RELEASE_STATUS_ELIGIBLE",
    expectedHandlerCode: "ACCESS_EVALUATION_V1",
    claim: (intentId, leaseToken, scope, now) =>
      claimGuestJourneyAccessEvaluationIntent(ownerRuntimeDb, {
        intentId,
        leaseToken,
        scope,
        leaseMs: 60_000,
        maxClaims: 3,
        now,
      }),
  },
  {
    label: "E7 COMMUNICATIONS delivery",
    targetEngine: "COMMUNICATIONS",
    intentType: "REQUEST_COMMUNICATION",
    expectedOutcomeCode: "COMMUNICATION_DELIVERY_FINAL",
    expectedHandlerCode: "COMMUNICATION_RETRY_V1",
    claim: (intentId, leaseToken, scope, now) =>
      claimGuestJourneyCommunicationIntent(communicationsRuntimeDb, {
        intentId,
        leaseToken,
        scope,
        leaseMs: 60_000,
        maxClaims: 3,
        now,
      }),
  },
  {
    label: "E7 COMMUNICATIONS retry",
    targetEngine: "COMMUNICATIONS",
    intentType: "REQUEST_COMMUNICATION_RETRY",
    expectedOutcomeCode: "COMMUNICATION_DELIVERY_FINAL",
    expectedHandlerCode: "COMMUNICATION_RETRY_V1",
    claim: (intentId, leaseToken, scope, now) =>
      claimGuestJourneyCommunicationIntent(communicationsRuntimeDb, {
        intentId,
        leaseToken,
        scope,
        leaseMs: 60_000,
        maxClaims: 3,
        now,
      }),
  },
  {
    label: "E8 ACCESS provisioning",
    targetEngine: "ACCESS",
    intentType: "REQUEST_ACCESS_PROVISIONING",
    expectedOutcomeCode: "SECURE_GUEST_ACCESS_ACTIVE",
    expectedHandlerCode: "ACCESS_PROVISIONING_V1",
    claim: (intentId, leaseToken, scope, now) =>
      claimGuestJourneyAccessIntent(accessOwnerRuntimeDb, {
        intentId,
        leaseToken,
        scope,
        leaseMs: 60_000,
        maxClaims: 3,
        now,
      }),
  },
  {
    label: "E8 ACCESS revocation",
    targetEngine: "ACCESS",
    intentType: "REQUEST_ACCESS_REVOCATION_CHECK",
    expectedOutcomeCode: "ALL_GUEST_ACCESS_CLOSED",
    expectedHandlerCode: "ACCESS_REVOCATION_CHECK_V1",
    claim: (intentId, leaseToken, scope, now) =>
      claimGuestJourneyAccessIntent(accessOwnerRuntimeDb, {
        intentId,
        leaseToken,
        scope,
        leaseMs: 60_000,
        maxClaims: 3,
        now,
      }),
  },
  {
    label: "E9 FINANCIAL payment evaluation",
    targetEngine: "FINANCIAL",
    intentType: "REQUEST_PAYMENT_EVALUATION",
    expectedOutcomeCode: "PAYMENT_STATE_RESOLVED",
    expectedHandlerCode: "PAYMENT_EVALUATION_V1",
    claim: (intentId, leaseToken, scope, now) =>
      claimGuestJourneyFinancialIntent(financialOwnerRuntimeDb, {
        intentId,
        leaseToken,
        scope,
        leaseMs: 60_000,
        maxClaims: 3,
        now,
      }),
  },
  {
    label: "E10 COMPLIANCE requirements snapshot",
    targetEngine: "COMPLIANCE",
    intentType: "REQUEST_REQUIREMENTS_SNAPSHOT",
    expectedOutcomeCode: "REQUIREMENTS_SNAPSHOTS_PRESENT",
    expectedHandlerCode: "REQUIREMENTS_SNAPSHOT_V1",
    claim: (intentId, leaseToken, scope, now) =>
      claimGuestJourneyComplianceIntent(complianceOwnerRuntimeDb, {
        intentId,
        leaseToken,
        scope,
        leaseMs: 60_000,
        maxClaims: 3,
        now,
      }),
  },
  {
    label: "E10 COMPLIANCE guest verification",
    targetEngine: "COMPLIANCE",
    intentType: "REQUEST_GUEST_VERIFICATION",
    expectedOutcomeCode: "GUEST_VERIFICATION_REQUIREMENTS_SATISFIED",
    expectedHandlerCode: "GUEST_VERIFICATION_V1",
    claim: (intentId, leaseToken, scope, now) =>
      claimGuestJourneyComplianceIntent(complianceOwnerRuntimeDb, {
        intentId,
        leaseToken,
        scope,
        leaseMs: 60_000,
        maxClaims: 3,
        now,
      }),
  },
];

type SqlExecutor = Pick<Prisma.TransactionClient, "$executeRawUnsafe">;

async function createTempAttemptTable(tx: SqlExecutor): Promise<void> {
  await tx.$executeRawUnsafe(`
    CREATE TEMP TABLE "GuestJourneyCoordinationIntentAttemptContractProbe"
    (
      LIKE "GuestJourneyCoordinationIntentAttempt"
      INCLUDING DEFAULTS
      INCLUDING CONSTRAINTS
    )
    ON COMMIT DROP
  `);
}

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

async function insertProbe(
  tx: SqlExecutor,
  input: {
    id: string;
    targetEngine: string;
    intentType: string;
    handlerCode: string;
  }
): Promise<void> {
  const fingerprint = "a".repeat(64);
  await tx.$executeRawUnsafe(`
    INSERT INTO "GuestJourneyCoordinationIntentAttemptContractProbe" (
      "id",
      "intentId",
      "attemptNumber",
      "targetEngine",
      "intentType",
      "handlerCode",
      "leaseTokenFingerprint",
      "inputEvidenceFingerprint",
      "outcome",
      "startedAt",
      "leaseExpiresAt",
      "updatedAt"
    ) VALUES (
      ${sqlLiteral(input.id)},
      'contract-probe-intent',
      1,
      ${sqlLiteral(input.targetEngine)},
      ${sqlLiteral(input.intentType)},
      ${sqlLiteral(input.handlerCode)},
      '${fingerprint}',
      '${fingerprint}',
      'IN_FLIGHT',
      NOW(),
      NOW() + INTERVAL '1 minute',
      NOW()
    )
  `);
}

function isTargetCheckViolation(error: unknown): boolean {
  const candidate = error as {
    message?: unknown;
    code?: unknown;
    meta?: unknown;
  };
  const rendered = [
    candidate?.message,
    candidate?.code,
    JSON.stringify(candidate?.meta ?? null),
  ]
    .map((value) => String(value ?? ""))
    .join(" ");

  return (
    rendered.includes(TARGET_CHECK_NAME) ||
    rendered.includes("23514") ||
    rendered.toLowerCase().includes("check constraint")
  );
}

test("production owner claim runtimes persist every canonical attempt tuple through real Prisma and PostgreSQL", async () => {
  const runId = `${process.pid}-${Date.now()}`;
  const organization = await prisma.organization.create({
    data: { name: `Owner Attempt Contract ${runId}` },
  });
  const property = await prisma.property.create({
    data: {
      organizationId: organization.id,
      name: `Owner Attempt Property ${runId}`,
    },
  });
  const now = new Date("2026-08-29T17:30:00.000Z");
  const reservation = await prisma.reservation.create({
    data: {
      propertyId: property.id,
      guestName: "Owner Attempt Contract Guest",
      checkIn: now,
      checkOut: new Date(now.getTime() + 24 * 60 * 60_000),
    },
  });
  const journey = await prisma.guestJourney.create({
    data: { reservationId: reservation.id },
  });
  const scope = {
    organizationIds: [organization.id],
    propertyIds: [property.id],
  };

  for (const [index, runtimeCase] of runtimeCases.entries()) {
    const intent = await prisma.guestJourneyCoordinationIntent.create({
      data: {
        intentKey: `owner-attempt-contract:${runId}:${index + 1}`,
        reservationId: reservation.id,
        journeyId: journey.id,
        intentType: runtimeCase.intentType,
        targetEngine: runtimeCase.targetEngine,
        reasonCode: "OWNER_ATTEMPT_DB_CONTRACT_CERTIFICATION",
        expectedOutcomeCode: runtimeCase.expectedOutcomeCode,
        evidenceFingerprint: "b".repeat(64),
        payload:
          runtimeCase.targetEngine === "COMMUNICATIONS"
            ? { communicationType: "BOOKING_CONFIRMATION" }
            : undefined,
      },
    });

    const result = await runtimeCase.claim(
      intent.id,
      `owner-attempt-contract-lease-${index + 1}`,
      scope,
      new Date(now.getTime() + index * 1_000)
    );
    assert.equal(result.claimed, true, `${runtimeCase.label} must claim successfully`);

    const attempt = await prisma.guestJourneyCoordinationIntentAttempt.findUnique({
      where: {
        intentId_attemptNumber: {
          intentId: intent.id,
          attemptNumber: 1,
        },
      },
      select: {
        targetEngine: true,
        intentType: true,
        handlerCode: true,
      },
    });

    assert.deepEqual(
      attempt,
      {
        targetEngine: runtimeCase.targetEngine,
        intentType: runtimeCase.intentType,
        handlerCode: runtimeCase.expectedHandlerCode,
      },
      `${runtimeCase.label} must persist its production tuple`
    );
  }
});

for (const [index, combination] of invalidCombinations.entries()) {
  const [targetEngine, intentType, handlerCode] = combination;

  test(`owner attempt DB contract rejects non-canonical tuple ${index + 1}`, async () => {
    await assert.rejects(
      prisma.$transaction(async (tx) => {
        await createTempAttemptTable(tx);
        await insertProbe(tx, {
          id: `invalid-${index + 1}`,
          targetEngine,
          intentType,
          handlerCode,
        });
      }),
      isTargetCheckViolation
    );
  });
}

test.after(async () => {
  await prisma.$disconnect();
});
