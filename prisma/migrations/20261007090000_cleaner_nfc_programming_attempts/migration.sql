-- Additive provenance for cleaner programming. Existing grants are not backfilled.
CREATE TABLE "CleanerNfcProgrammingAttempt" (
    "id" TEXT NOT NULL,
    "nfcAssignmentId" TEXT NOT NULL,
    "confirmationId" TEXT NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "organizationId" TEXT NOT NULL,
    "ttlockLockId" INTEGER NOT NULL,
    "ttlockCardId" INTEGER NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'PREPARED',
    "acknowledgedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CleanerNfcProgrammingAttempt_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CleanerNfcProgrammingAttempt_attemptNumber_check" CHECK ("attemptNumber" > 0),
    CONSTRAINT "CleanerNfcProgrammingAttempt_window_check" CHECK ("endsAt" > "startsAt"),
    CONSTRAINT "CleanerNfcProgrammingAttempt_state_check" CHECK ("state" IN ('PREPARED', 'ABORTED', 'ACKNOWLEDGED', 'UNCERTAIN'))
);

CREATE UNIQUE INDEX "CleanerNfcProgrammingAttempt_nfcAssignmentId_attemptNumber_key"
    ON "CleanerNfcProgrammingAttempt"("nfcAssignmentId", "attemptNumber");
CREATE INDEX "CleanerNfcProgrammingAttempt_target_state_idx"
    ON "CleanerNfcProgrammingAttempt"("organizationId", "ttlockLockId", "ttlockCardId", "state");
ALTER TABLE "CleanerNfcProgrammingAttempt" ADD CONSTRAINT "CleanerNfcProgrammingAttempt_nfcAssignmentId_fkey"
    FOREIGN KEY ("nfcAssignmentId") REFERENCES "NfcAssignment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
