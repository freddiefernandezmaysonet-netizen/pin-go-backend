CREATE TABLE "HostMobilePushDevice" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL REFERENCES "DashboardUser"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "organizationId" TEXT NOT NULL, "sessionId" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL UNIQUE, "tokenCiphertext" TEXT NOT NULL, "bindingVersion" INTEGER NOT NULL DEFAULT 1,
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
-- This draft migration has never been applied to a persistent environment.
-- No credentials, source text or token ciphertext is copied to the ledger.
CREATE TABLE "HostMobilePushDelivery" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "sourceId" TEXT NOT NULL, "sourceEpoch" INTEGER NOT NULL,
  "organizationId" TEXT NOT NULL, "propertyId" TEXT NOT NULL,
  "userId" TEXT NOT NULL, "sessionId" TEXT NOT NULL,
  "deviceId" TEXT NOT NULL, "deviceUpdatedAt" TIMESTAMP(3) NOT NULL, "deviceBindingVersion" INTEGER NOT NULL,
  "eventId" TEXT NOT NULL, "kind" TEXT NOT NULL,
  "occurredAt" TIMESTAMP(3) NOT NULL, "expiresAt" TIMESTAMP(3) NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'QUEUED',
  "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "leaseOwner" TEXT, "leaseUntil" TIMESTAMP(3),
  "leaseEpoch" INTEGER NOT NULL DEFAULT 0, "attempts" INTEGER NOT NULL DEFAULT 0,
  "ticketId" TEXT, "acceptedAt" TIMESTAMP(3), "receiptDeadline" TIMESTAMP(3),
  "outcomeCode" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX "HostMobilePushDelivery_source_device_user_key"
  ON "HostMobilePushDelivery"("sourceId", "sourceEpoch", "deviceId", "userId");
CREATE INDEX "HostMobilePushDelivery_state_availableAt_idx" ON "HostMobilePushDelivery"("state", "availableAt");
CREATE INDEX "HostMobilePushDelivery_leaseUntil_idx" ON "HostMobilePushDelivery"("leaseUntil");
CREATE INDEX "HostMobilePushDelivery_organizationId_userId_idx" ON "HostMobilePushDelivery"("organizationId", "userId");
-- Exact per-Host message acknowledgement. No message content or guest read receipt.
CREATE TABLE "HostMobileMessageRead" (
  "organizationId" TEXT NOT NULL, "userId" TEXT NOT NULL, "propertyId" TEXT NOT NULL,
  "threadId" TEXT NOT NULL, "messageId" TEXT NOT NULL,
  "readAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "HostMobileMessageRead_scope_key" PRIMARY KEY ("organizationId", "userId", "propertyId", "threadId", "messageId")
);
CREATE INDEX "HostMobileMessageRead_readAt_idx" ON "HostMobileMessageRead"("readAt");
