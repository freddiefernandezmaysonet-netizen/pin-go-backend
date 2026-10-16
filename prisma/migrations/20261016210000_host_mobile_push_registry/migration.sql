CREATE TABLE "HostMobilePushDevice" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL REFERENCES "DashboardUser"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "organizationId" TEXT NOT NULL, "sessionId" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL UNIQUE, "tokenCiphertext" TEXT NOT NULL,
  "platform" TEXT NOT NULL, "projectId" TEXT NOT NULL,
  "revokedAt" TIMESTAMP(3), "expiresAt" TIMESTAMP(3) NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "HostMobilePushDevice_organizationId_userId_sessionId_idx" ON "HostMobilePushDevice"("organizationId","userId","sessionId");
CREATE TABLE "HostMobilePushPreference" (
  "userId" TEXT NOT NULL PRIMARY KEY REFERENCES "DashboardUser"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "organizationId" TEXT NOT NULL, "enabled" BOOLEAN NOT NULL DEFAULT false,
  "kinds" TEXT[] NOT NULL, "timezone" TEXT NOT NULL DEFAULT 'UTC',
  "quietStartHour" INTEGER, "quietEndHour" INTEGER, "allowCritical" BOOLEAN NOT NULL DEFAULT false,
  "revision" INTEGER NOT NULL DEFAULT 0, "updatedAt" TIMESTAMP(3) NOT NULL
);
