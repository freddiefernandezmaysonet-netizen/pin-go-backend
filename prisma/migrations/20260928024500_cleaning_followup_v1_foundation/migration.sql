-- Cleaning Follow-up V1 foundation.
-- Additive only: no backfill, no message dispatch, no access-window changes.
ALTER TABLE "PropertyStaff"
  ADD COLUMN "cleaningDurationCommitmentMinutes" INTEGER,
  ADD COLUMN "cleaningStartConfirmationGraceMinutes" INTEGER NOT NULL DEFAULT 30,
  ADD COLUMN "cleaningFollowupGraceMinutes" INTEGER NOT NULL DEFAULT 15;

ALTER TABLE "PropertyStaff"
  ADD CONSTRAINT "PropertyStaff_cleaningDurationCommitmentMinutes_check"
    CHECK ("cleaningDurationCommitmentMinutes" IS NULL OR ("cleaningDurationCommitmentMinutes" BETWEEN 15 AND 1440)),
  ADD CONSTRAINT "PropertyStaff_cleaningStartConfirmationGraceMinutes_check"
    CHECK ("cleaningStartConfirmationGraceMinutes" BETWEEN 5 AND 240),
  ADD CONSTRAINT "PropertyStaff_cleaningFollowupGraceMinutes_check"
    CHECK ("cleaningFollowupGraceMinutes" BETWEEN 5 AND 240);

CREATE TABLE "CleaningWork" (
  "id" TEXT NOT NULL,
  "reservationId" TEXT NOT NULL,
  "propertyId" TEXT NOT NULL,
  "staffMemberId" TEXT NOT NULL,
  "confirmationId" TEXT,
  "scheduledStartAt" TIMESTAMP(3) NOT NULL,
  "durationCommitmentMinutes" INTEGER NOT NULL,
  "startConfirmationGraceMinutes" INTEGER NOT NULL,
  "followupGraceMinutes" INTEGER NOT NULL,
  "startConfirmedAt" TIMESTAMP(3),
  "completionConfirmedAt" TIMESTAMP(3),
  "cancelledAt" TIMESTAMP(3),
  "supersededAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CleaningWork_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CleaningWork_durationCommitmentMinutes_check"
    CHECK ("durationCommitmentMinutes" BETWEEN 15 AND 1440),
  CONSTRAINT "CleaningWork_startConfirmationGraceMinutes_check"
    CHECK ("startConfirmationGraceMinutes" BETWEEN 5 AND 240),
  CONSTRAINT "CleaningWork_followupGraceMinutes_check"
    CHECK ("followupGraceMinutes" BETWEEN 5 AND 240)
);

CREATE UNIQUE INDEX "CleaningWork_reservationId_staffMemberId_key"
  ON "CleaningWork"("reservationId", "staffMemberId");
CREATE INDEX "CleaningWork_propertyId_scheduledStartAt_idx"
  ON "CleaningWork"("propertyId", "scheduledStartAt");
CREATE INDEX "CleaningWork_staffMemberId_scheduledStartAt_idx"
  ON "CleaningWork"("staffMemberId", "scheduledStartAt");
CREATE INDEX "CleaningWork_startConfirmedAt_completionConfirmedAt_cancelledAt_supersededAt_idx"
  ON "CleaningWork"("startConfirmedAt", "completionConfirmedAt", "cancelledAt", "supersededAt");
