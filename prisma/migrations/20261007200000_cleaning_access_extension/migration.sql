CREATE TABLE "CleaningAccessExtension" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "reportId" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "propertyId" TEXT NOT NULL,
  "reservationId" TEXT NOT NULL,
  "cleaningWorkId" TEXT NOT NULL,
  "confirmationId" TEXT NOT NULL,
  "nfcAssignmentId" TEXT NOT NULL,
  "nfcCardId" TEXT NOT NULL,
  "ttlockLockId" INTEGER NOT NULL,
  "ttlockCardId" INTEGER NOT NULL,
  "policyRevision" INTEGER NOT NULL,
  "startsAt" TIMESTAMP(3) NOT NULL,
  "previousEndsAt" TIMESTAMP(3) NOT NULL,
  "proposedEndsAt" TIMESTAMP(3) NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'PREPARED',
  "acknowledgedAt" TIMESTAMP(3),
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CleaningAccessExtension_report_fkey" FOREIGN KEY ("reportId") REFERENCES "CleaningWorkIssueReport"("id") ON DELETE RESTRICT,
  CONSTRAINT "CleaningAccessExtension_period_check" CHECK ("startsAt" < "previousEndsAt" AND "previousEndsAt" < "proposedEndsAt"),
  CONSTRAINT "CleaningAccessExtension_state_check" CHECK ("state" IN ('PREPARED', 'SENDING', 'APPLIED', 'UNCERTAIN', 'ABORTED'))
);
CREATE UNIQUE INDEX "CleaningAccessExtension_reportId_key" ON "CleaningAccessExtension"("reportId");
CREATE INDEX "CleaningAccessExtension_reservationId_state_idx" ON "CleaningAccessExtension"("reservationId", "state");
CREATE INDEX "CleaningAccessExtension_state_updatedAt_idx" ON "CleaningAccessExtension"("state", "updatedAt");
ALTER TABLE "CleaningHostAttentionNotice" ADD COLUMN "reasonCode" TEXT;
