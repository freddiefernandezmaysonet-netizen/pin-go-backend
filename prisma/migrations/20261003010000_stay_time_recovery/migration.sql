ALTER TABLE "ReservationModification"
  ADD COLUMN "stayTimeReconciledAt" TIMESTAMP(3),
  ADD COLUMN "stayTimeRecoveryNextAt" TIMESTAMP(3),
  ADD COLUMN "stayTimeRecoveryLeaseToken" TEXT,
  ADD COLUMN "stayTimeRecoveryLeaseUntil" TIMESTAMP(3),
  ADD COLUMN "stayTimeRecoveryAttempts" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX "ReservationModification_stay_time_recovery_idx"
  ON "ReservationModification"("requestSource", "status", "stayTimeRecoveryNextAt");
