ALTER TYPE "DashboardUserRole" ADD VALUE 'CLEANER';
ALTER TABLE "StaffMember" ADD COLUMN "dashboardUserId" TEXT,
  ADD COLUMN "cleanerAccountEmail" VARCHAR(320),
  ADD COLUMN "cleanerAccountRequestedAt" TIMESTAMP(3);
CREATE UNIQUE INDEX "StaffMember_dashboardUserId_key" ON "StaffMember"("dashboardUserId");
ALTER TABLE "StaffMember" ADD CONSTRAINT "StaffMember_dashboardUserId_fkey"
  FOREIGN KEY ("dashboardUserId") REFERENCES "DashboardUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE TABLE "CleanerAccountActivation" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "staffMemberId" TEXT NOT NULL,
  "confirmationId" TEXT NOT NULL,
  "email" VARCHAR(320) NOT NULL,
  "requestedAt" TIMESTAMP(3) NOT NULL,
  "tokenHash" VARCHAR(64) NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CleanerAccountActivation_staffMemberId_fkey" FOREIGN KEY ("staffMemberId")
    REFERENCES "StaffMember"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "CleanerAccountActivation_tokenHash_key" ON "CleanerAccountActivation"("tokenHash");
CREATE INDEX "CleanerAccountActivation_staffMemberId_expiresAt_idx" ON "CleanerAccountActivation"("staffMemberId", "expiresAt");
