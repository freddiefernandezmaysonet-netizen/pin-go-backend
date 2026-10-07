CREATE TABLE "CleaningWorkIssueReport" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "cleaningWorkId" TEXT NOT NULL,
  "requestId" TEXT NOT NULL,
  "kind" TEXT NOT NULL CHECK ("kind" IN ('DELAY', 'MORE_TIME', 'INCOMPLETE')),
  "reason" TEXT NOT NULL CHECK (length("reason") BETWEEN 1 AND 1000),
  "estimatedAt" TIMESTAMP(3),
  "reportedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CleaningWorkIssueReport_work_fkey" FOREIGN KEY ("cleaningWorkId") REFERENCES "CleaningWork"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "CleaningWorkIssueReport_cleaningWorkId_requestId_key" ON "CleaningWorkIssueReport"("cleaningWorkId", "requestId");
CREATE INDEX "CleaningWorkIssueReport_cleaningWorkId_reportedAt_idx" ON "CleaningWorkIssueReport"("cleaningWorkId", "reportedAt");
