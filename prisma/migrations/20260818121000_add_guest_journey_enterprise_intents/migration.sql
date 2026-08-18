-- APMS Enterprise Guest Journey E1
-- Durable coordination contract only. No worker or owner Engine is activated.

CREATE TYPE "GuestJourneyCoordinationIntentStatus" AS ENUM (
  'PENDING',
  'CLAIMED',
  'WAITING_FOR_EVIDENCE',
  'RETRYABLE',
  'SUCCEEDED',
  'EXHAUSTED',
  'SUPERSEDED'
);

CREATE TABLE "GuestJourneyCoordinationIntent" (
  "id" TEXT NOT NULL,
  "intentKey" TEXT NOT NULL,
  "reservationId" TEXT NOT NULL,
  "journeyId" TEXT NOT NULL,

  "contractVersion" TEXT NOT NULL DEFAULT 'guest_journey_coordination_intent_v1',
  "intentType" TEXT NOT NULL,
  "targetEngine" TEXT NOT NULL,
  "reasonCode" TEXT NOT NULL,
  "expectedOutcomeCode" TEXT NOT NULL,
  "evidenceFingerprint" TEXT NOT NULL,
  "payload" JSONB,

  "status" "GuestJourneyCoordinationIntentStatus" NOT NULL DEFAULT 'PENDING',

  "claimCount" INTEGER NOT NULL DEFAULT 0,
  "leaseToken" TEXT,
  "claimedAt" TIMESTAMP(3),
  "leaseExpiresAt" TIMESTAMP(3),
  "lastAttemptAt" TIMESTAMP(3),
  "nextActionAt" TIMESTAMP(3),

  "succeededAt" TIMESTAMP(3),
  "exhaustedAt" TIMESTAMP(3),
  "supersededAt" TIMESTAMP(3),

  "outcomeEvidenceFingerprint" TEXT,
  "lastError" TEXT,

  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "GuestJourneyCoordinationIntent_pkey"
    PRIMARY KEY ("id"),

  CONSTRAINT "GuestJourneyCoordinationIntent_targetEngine_check"
    CHECK (
      "targetEngine" IN (
        'COMPLIANCE',
        'COMMUNICATIONS',
        'ACCESS',
        'FINANCIAL'
      )
    ),

  CONSTRAINT "GuestJourneyCoordinationIntent_intentType_check"
    CHECK (
      "intentType" IN (
        'REQUEST_REQUIREMENTS_SNAPSHOT',
        'REQUEST_GUEST_VERIFICATION',
        'REQUEST_COMMUNICATION',
        'REQUEST_COMMUNICATION_RETRY',
        'REQUEST_ACCESS_EVALUATION',
        'REQUEST_ACCESS_PROVISIONING',
        'REQUEST_ACCESS_REVOCATION_CHECK',
        'REQUEST_PAYMENT_EVALUATION'
      )
    )
);

CREATE UNIQUE INDEX
  "GuestJourneyCoordinationIntent_intentKey_key"
ON
  "GuestJourneyCoordinationIntent"("intentKey");

CREATE INDEX
  "GuestJourneyCoordinationIntent_reservationId_status_idx"
ON
  "GuestJourneyCoordinationIntent"("reservationId", "status");

CREATE INDEX
  "GuestJourneyCoordinationIntent_journeyId_status_idx"
ON
  "GuestJourneyCoordinationIntent"("journeyId", "status");

CREATE INDEX
  "GuestJourneyCoordinationIntent_targetEngine_status_nextActionAt_idx"
ON
  "GuestJourneyCoordinationIntent"(
    "targetEngine",
    "status",
    "nextActionAt"
  );

CREATE INDEX
  "GuestJourneyCoordinationIntent_status_leaseExpiresAt_idx"
ON
  "GuestJourneyCoordinationIntent"("status", "leaseExpiresAt");

CREATE INDEX
  "GuestJourneyCoordinationIntent_intentType_status_idx"
ON
  "GuestJourneyCoordinationIntent"("intentType", "status");

CREATE INDEX
  "GuestJourneyCoordinationIntent_evidenceFingerprint_idx"
ON
  "GuestJourneyCoordinationIntent"("evidenceFingerprint");

ALTER TABLE
  "GuestJourneyCoordinationIntent"
ADD CONSTRAINT
  "GuestJourneyCoordinationIntent_reservationId_fkey"
FOREIGN KEY
  ("reservationId")
REFERENCES
  "Reservation"("id")
ON DELETE CASCADE
ON UPDATE CASCADE;

ALTER TABLE
  "GuestJourneyCoordinationIntent"
ADD CONSTRAINT
  "GuestJourneyCoordinationIntent_journeyId_fkey"
FOREIGN KEY
  ("journeyId")
REFERENCES
  "GuestJourney"("id")
ON DELETE CASCADE
ON UPDATE CASCADE;
