-- Pin AI Action Proposal Foundation V1.
-- Additive only: this migration introduces a consent/proposal boundary and
-- does not execute any reservation, payment, access, messaging or provider action.

CREATE TYPE "PinAIActionProposalType" AS ENUM (
    'RESERVATION_MODIFICATION'
);

CREATE TYPE "PinAIActionProposalStatus" AS ENUM (
    'PENDING_CONFIRMATION',
    'CONFIRMED',
    'EXPIRED',
    'CANCELLED',
    'SUPERSEDED'
);

CREATE TABLE "PinAIActionProposal" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "reservationId" TEXT NOT NULL,
    "version" TEXT NOT NULL DEFAULT 'pin_ai_action_proposal_v1',
    "actionType" "PinAIActionProposalType" NOT NULL,
    "status" "PinAIActionProposalStatus" NOT NULL DEFAULT 'PENDING_CONFIRMATION',
    "proposalFingerprint" VARCHAR(64) NOT NULL,
    "baseReservationUpdatedAt" TIMESTAMP(3) NOT NULL,
    "language" VARCHAR(2) NOT NULL,
    "consentText" TEXT NOT NULL,
    "termsSnapshot" JSONB NOT NULL,
    "confirmationTokenHash" VARCHAR(64) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "confirmedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "supersededAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PinAIActionProposal_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PinAIActionProposal_version_check"
      CHECK ("version" = 'pin_ai_action_proposal_v1'),
    CONSTRAINT "PinAIActionProposal_language_check"
      CHECK ("language" IN ('en', 'es')),
    CONSTRAINT "PinAIActionProposal_fingerprint_check"
      CHECK ("proposalFingerprint" ~ '^[a-f0-9]{64}$'),
    CONSTRAINT "PinAIActionProposal_confirmation_token_hash_check"
      CHECK ("confirmationTokenHash" ~ '^[a-f0-9]{64}$'),
    CONSTRAINT "PinAIActionProposal_expiry_check"
      CHECK ("expiresAt" > "createdAt"),
    CONSTRAINT "PinAIActionProposal_state_timestamp_check"
      CHECK (
        (
          "status" = 'PENDING_CONFIRMATION'
          AND "confirmedAt" IS NULL
          AND "cancelledAt" IS NULL
          AND "supersededAt" IS NULL
        )
        OR (
          "status" = 'CONFIRMED'
          AND "confirmedAt" IS NOT NULL
          AND "cancelledAt" IS NULL
          AND "supersededAt" IS NULL
        )
        OR (
          "status" = 'EXPIRED'
          AND "confirmedAt" IS NULL
          AND "cancelledAt" IS NULL
          AND "supersededAt" IS NULL
        )
        OR (
          "status" = 'CANCELLED'
          AND "confirmedAt" IS NULL
          AND "cancelledAt" IS NOT NULL
          AND "supersededAt" IS NULL
        )
        OR (
          "status" = 'SUPERSEDED'
          AND "cancelledAt" IS NULL
          AND "supersededAt" IS NOT NULL
        )
      )
);

CREATE UNIQUE INDEX "PinAIActionProposal_confirmationTokenHash_key"
ON "PinAIActionProposal"("confirmationTokenHash");

CREATE INDEX "PinAIActionProposal_organizationId_propertyId_reservationId_idx"
ON "PinAIActionProposal"("organizationId", "propertyId", "reservationId");

CREATE INDEX "PinAIActionProposal_reservationId_actionType_status_expiresAt_idx"
ON "PinAIActionProposal"("reservationId", "actionType", "status", "expiresAt");

CREATE UNIQUE INDEX "PinAIActionProposal_one_pending_per_reservation_action_key"
ON "PinAIActionProposal"("reservationId", "actionType")
WHERE "status" = 'PENDING_CONFIRMATION';

CREATE INDEX "PinAIActionProposal_proposalFingerprint_idx"
ON "PinAIActionProposal"("proposalFingerprint");

CREATE INDEX "PinAIActionProposal_status_expiresAt_idx"
ON "PinAIActionProposal"("status", "expiresAt");

ALTER TABLE "PinAIActionProposal"
ADD CONSTRAINT "PinAIActionProposal_reservationId_fkey"
FOREIGN KEY ("reservationId") REFERENCES "Reservation"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
