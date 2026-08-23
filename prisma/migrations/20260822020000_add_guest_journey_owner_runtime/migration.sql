-- APMS Enterprise Guest Journey E5
-- Durable owner Engine attempt evidence. Runtime remains disabled by default.

CREATE TYPE "GuestJourneyCoordinationAttemptOutcome" AS ENUM (
  'IN_FLIGHT',
  'LEASE_EXPIRED',
  'WAITING_FOR_EVIDENCE',
  'RETRYABLE',
  'SUCCEEDED',
  'EXHAUSTED'
);

CREATE TABLE "GuestJourneyCoordinationIntentAttempt" (
  "id" TEXT NOT NULL,
  "intentId" TEXT NOT NULL,
  "attemptNumber" INTEGER NOT NULL,
  "targetEngine" TEXT NOT NULL,
  "intentType" TEXT NOT NULL,
  "handlerCode" TEXT NOT NULL,
  "leaseTokenFingerprint" TEXT NOT NULL,
  "inputEvidenceFingerprint" TEXT NOT NULL,
  "outcome" "GuestJourneyCoordinationAttemptOutcome" NOT NULL DEFAULT 'IN_FLIGHT',
  "startedAt" TIMESTAMP(3) NOT NULL,
  "leaseExpiresAt" TIMESTAMP(3) NOT NULL,
  "completedAt" TIMESTAMP(3),
  "outcomeEvidenceFingerprint" TEXT,
  "errorCode" TEXT,
  "errorDetail" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "GuestJourneyCoordinationIntentAttempt_pkey"
    PRIMARY KEY ("id"),

  CONSTRAINT "GuestJourneyCoordinationIntentAttempt_attemptNumber_check"
    CHECK ("attemptNumber" > 0),

  CONSTRAINT "GuestJourneyCoordinationIntentAttempt_target_check"
    CHECK (
      "targetEngine" = 'ACCESS' AND
      "intentType" = 'REQUEST_ACCESS_EVALUATION' AND
      "handlerCode" = 'ACCESS_EVALUATION_V1'
    ),

  CONSTRAINT "GuestJourneyCoordinationIntentAttempt_fingerprint_check"
    CHECK (
      "leaseTokenFingerprint" ~ '^[0-9a-f]{64}$' AND
      "inputEvidenceFingerprint" ~ '^[0-9a-f]{64}$' AND
      (
        "outcomeEvidenceFingerprint" IS NULL OR
        "outcomeEvidenceFingerprint" ~ '^[0-9a-f]{64}$'
      )
    ),

  CONSTRAINT "GuestJourneyCoordinationIntentAttempt_completion_check"
    CHECK (
      (
        "outcome" = 'IN_FLIGHT' AND
        "completedAt" IS NULL
      ) OR
      (
        "outcome" <> 'IN_FLIGHT' AND
        "completedAt" IS NOT NULL
      )
    )
);

CREATE UNIQUE INDEX
  "GuestJourneyCoordinationIntentAttempt_intentId_attemptNumber_key"
ON
  "GuestJourneyCoordinationIntentAttempt"("intentId", "attemptNumber");

CREATE INDEX
  "GuestJourneyCoordinationIntentAttempt_outcome_leaseExpiresAt_idx"
ON
  "GuestJourneyCoordinationIntentAttempt"("outcome", "leaseExpiresAt");

CREATE INDEX
  "GuestJourneyCoordinationIntentAttempt_targetEngine_intentType_outcome_idx"
ON
  "GuestJourneyCoordinationIntentAttempt"(
    "targetEngine",
    "intentType",
    "outcome"
  );

ALTER TABLE
  "GuestJourneyCoordinationIntentAttempt"
ADD CONSTRAINT
  "GuestJourneyCoordinationIntentAttempt_intentId_fkey"
FOREIGN KEY
  ("intentId")
REFERENCES
  "GuestJourneyCoordinationIntent"("id")
ON DELETE CASCADE
ON UPDATE CASCADE;

ALTER TABLE
  "GuestJourneyCoordinationIntent"
ADD CONSTRAINT
  "GuestJourneyCoordinationIntent_claim_lease_check"
CHECK (
  "claimCount" >= 0 AND
  (
    (
      "status" = 'CLAIMED' AND
      "leaseToken" IS NOT NULL AND
      "claimedAt" IS NOT NULL AND
      "leaseExpiresAt" IS NOT NULL
    ) OR
    (
      "status" <> 'CLAIMED' AND
      "leaseToken" IS NULL AND
      "claimedAt" IS NULL AND
      "leaseExpiresAt" IS NULL
    )
  )
);
