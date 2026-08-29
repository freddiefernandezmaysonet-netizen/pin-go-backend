import assert from "node:assert/strict";
import test from "node:test";

import { Prisma, PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const TARGET_CHECK_NAME =
  "GuestJourneyCoordinationIntentAttempt_target_check";

const validCombinations = [
  ["ACCESS", "REQUEST_ACCESS_EVALUATION", "ACCESS_EVALUATION_V1"],
  ["ACCESS", "REQUEST_ACCESS_PROVISIONING", "ACCESS_PROVISIONING_V1"],
  ["ACCESS", "REQUEST_ACCESS_REVOCATION_CHECK", "ACCESS_REVOCATION_CHECK_V1"],
  ["COMMUNICATIONS", "REQUEST_COMMUNICATION", "COMMUNICATION_RETRY_V1"],
  ["COMMUNICATIONS", "REQUEST_COMMUNICATION_RETRY", "COMMUNICATION_RETRY_V1"],
  ["FINANCIAL", "REQUEST_PAYMENT_EVALUATION", "PAYMENT_EVALUATION_V1"],
  ["COMPLIANCE", "REQUEST_REQUIREMENTS_SNAPSHOT", "REQUIREMENTS_SNAPSHOT_V1"],
  ["COMPLIANCE", "REQUEST_GUEST_VERIFICATION", "GUEST_VERIFICATION_V1"],
] as const;

const invalidCombinations = [
  ["FINANCIAL", "REQUEST_PAYMENT_EVALUATION", "ACCESS_EVALUATION_V1"],
  ["COMPLIANCE", "REQUEST_PAYMENT_EVALUATION", "PAYMENT_EVALUATION_V1"],
  ["ACCESS", "REQUEST_ACCESS_PROVISIONING", "UNKNOWN_HANDLER"],
  ["COMMUNICATIONS", "UNKNOWN_INTENT", "COMMUNICATION_RETRY_V1"],
  ["UNKNOWN_ENGINE", "REQUEST_PAYMENT_EVALUATION", "PAYMENT_EVALUATION_V1"],
] as const;

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

test("owner attempt DB contract accepts every canonical Engine/intent/handler tuple", async () => {
  await prisma.$transaction(async (tx) => {
    await createTempAttemptTable(tx);

    for (const [index, combination] of validCombinations.entries()) {
      const [targetEngine, intentType, handlerCode] = combination;
      await insertProbe(tx, {
        id: `valid-${index + 1}`,
        targetEngine,
        intentType,
        handlerCode,
      });
    }
  });
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
