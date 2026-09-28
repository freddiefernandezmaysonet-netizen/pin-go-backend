-- Cleaning Follow-up V1 foundation.
-- Additive only: no backfill, no message dispatch, no access-window changes.
ALTER TABLE "PropertyStaff"
  ADD COLUMN "cleaningDurationCommitmentMinutes" INTEGER,
  ADD COLUMN "cleaningStartConfirmationGraceMinutes" INTEGER NOT NULL DEFAULT 30,
  ADD COLUMN "cleaningFollowupGraceMinutes" INTEGER NOT NULL DEFAULT 15;

ALTER TABLE "StaffAssignment"
  ADD COLUMN "cleaningDurationCommitmentMinutesSnapshot" INTEGER,
  ADD COLUMN "cleaningStartConfirmationGraceMinutesSnapshot" INTEGER,
  ADD COLUMN "cleaningFollowupGraceMinutesSnapshot" INTEGER,
  ADD COLUMN "cleaningStartConfirmedAt" TIMESTAMP(3),
  ADD COLUMN "cleaningCompletionConfirmedAt" TIMESTAMP(3);

ALTER TABLE "PropertyStaff"
  ADD CONSTRAINT "PropertyStaff_cleaningDurationCommitmentMinutes_check"
    CHECK ("cleaningDurationCommitmentMinutes" IS NULL OR ("cleaningDurationCommitmentMinutes" BETWEEN 15 AND 1440)),
  ADD CONSTRAINT "PropertyStaff_cleaningStartConfirmationGraceMinutes_check"
    CHECK ("cleaningStartConfirmationGraceMinutes" BETWEEN 5 AND 240),
  ADD CONSTRAINT "PropertyStaff_cleaningFollowupGraceMinutes_check"
    CHECK ("cleaningFollowupGraceMinutes" BETWEEN 5 AND 240);

ALTER TABLE "StaffAssignment"
  ADD CONSTRAINT "StaffAssignment_cleaningDurationCommitmentMinutesSnapshot_check"
    CHECK ("cleaningDurationCommitmentMinutesSnapshot" IS NULL OR ("cleaningDurationCommitmentMinutesSnapshot" BETWEEN 15 AND 1440)),
  ADD CONSTRAINT "StaffAssignment_cleaningStartConfirmationGraceMinutesSnapshot_check"
    CHECK ("cleaningStartConfirmationGraceMinutesSnapshot" IS NULL OR ("cleaningStartConfirmationGraceMinutesSnapshot" BETWEEN 5 AND 240)),
  ADD CONSTRAINT "StaffAssignment_cleaningFollowupGraceMinutesSnapshot_check"
    CHECK ("cleaningFollowupGraceMinutesSnapshot" IS NULL OR ("cleaningFollowupGraceMinutesSnapshot" BETWEEN 5 AND 240));
