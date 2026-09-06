-- OTA Distribution commercial persistence and one-time Connection Center sessions.
-- Additive only: no certified Channex tables, payloads, adapters or data are changed.
BEGIN;
SET LOCAL search_path = public, pg_catalog;

CREATE TYPE "DistributionPlatform" AS ENUM ('CHANNEX');
CREATE TYPE "DistributionProvisioningStatus" AS ENUM ('NOT_PROVISIONED', 'PROVISIONING', 'READY', 'FAILED');
CREATE TYPE "OtaProvider" AS ENUM ('AIRBNB', 'BOOKING_COM', 'EXPEDIA', 'VRBO');
CREATE TYPE "OtaChannelConnectionStatus" AS ENUM ('NOT_CONNECTED', 'AUTHORIZATION_REQUIRED', 'MAPPING_REQUIRED', 'READINESS_CHECK', 'ACTIVATION_PENDING', 'ACTIVE', 'DEGRADED', 'FAILED', 'DISCONNECTING', 'DISCONNECTED');
CREATE TYPE "OtaReadinessStatus" AS ENUM ('NOT_STARTED', 'REQUIRED', 'IN_PROGRESS', 'READY', 'BLOCKED', 'NOT_APPLICABLE');
CREATE TYPE "OtaConnectionSessionStatus" AS ENUM ('REQUESTED', 'TOKEN_ISSUED', 'OPENED', 'COMPLETED', 'EXPIRED', 'FAILED', 'CANCELLED');

CREATE TABLE "DistributionGroup" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "platform" "DistributionPlatform" NOT NULL DEFAULT 'CHANNEX',
  "externalGroupId" TEXT,
  "provisioningStatus" "DistributionProvisioningStatus" NOT NULL DEFAULT 'NOT_PROVISIONED',
  "provisionedAt" TIMESTAMP(3),
  "verifiedAt" TIMESTAMP(3),
  "lastErrorCode" TEXT,
  "lastErrorSummary" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DistributionGroup_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DistributionProperty" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "propertyId" TEXT NOT NULL,
  "groupId" TEXT,
  "platform" "DistributionPlatform" NOT NULL DEFAULT 'CHANNEX',
  "externalPropertyId" TEXT,
  "externalPrimaryRoomTypeId" TEXT,
  "externalPrimaryRatePlanId" TEXT,
  "provisioningStatus" "DistributionProvisioningStatus" NOT NULL DEFAULT 'NOT_PROVISIONED',
  "provisionedAt" TIMESTAMP(3),
  "verifiedAt" TIMESTAMP(3),
  "lastErrorCode" TEXT,
  "lastErrorSummary" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DistributionProperty_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "OtaChannelConnection" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "propertyId" TEXT NOT NULL,
  "distributionPropertyId" TEXT NOT NULL,
  "provider" "OtaProvider" NOT NULL,
  "status" "OtaChannelConnectionStatus" NOT NULL DEFAULT 'NOT_CONNECTED',
  "externalConnectionId" TEXT,
  "externalChannelCode" TEXT,
  "authorizationReadiness" "OtaReadinessStatus" NOT NULL DEFAULT 'REQUIRED',
  "mappingReadiness" "OtaReadinessStatus" NOT NULL DEFAULT 'NOT_STARTED',
  "distributionReadiness" "OtaReadinessStatus" NOT NULL DEFAULT 'NOT_STARTED',
  "paymentReadiness" "OtaReadinessStatus" NOT NULL DEFAULT 'NOT_STARTED',
  "taxReadiness" "OtaReadinessStatus" NOT NULL DEFAULT 'NOT_STARTED',
  "contentReadiness" "OtaReadinessStatus" NOT NULL DEFAULT 'NOT_STARTED',
  "activationRequestedAt" TIMESTAMP(3),
  "activatedAt" TIMESTAMP(3),
  "disconnectedAt" TIMESTAMP(3),
  "lastReadinessCheckedAt" TIMESTAMP(3),
  "lastFullSyncConfirmedAt" TIMESTAMP(3),
  "lastReservationReceivedAt" TIMESTAMP(3),
  "lastErrorCode" TEXT,
  "lastErrorSummary" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "OtaChannelConnection_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "OtaConnectionSession" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "propertyId" TEXT NOT NULL,
  "otaChannelConnectionId" TEXT NOT NULL,
  "requestedByUserId" TEXT NOT NULL,
  "provider" "OtaProvider" NOT NULL,
  "status" "OtaConnectionSessionStatus" NOT NULL DEFAULT 'REQUESTED',
  "requestKey" VARCHAR(120) NOT NULL,
  "tokenFingerprint" VARCHAR(64),
  "launchUrlOrigin" VARCHAR(255),
  "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "tokenIssuedAt" TIMESTAMP(3),
  "openedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "failedAt" TIMESTAMP(3),
  "cancelledAt" TIMESTAMP(3),
  "lastErrorCode" VARCHAR(120),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "OtaConnectionSession_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "OtaConnectionSession_token_fingerprint_check" CHECK ("tokenFingerprint" IS NULL OR "tokenFingerprint" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "OtaConnectionSession_expiration_check" CHECK ("expiresAt" > "requestedAt"),
  CONSTRAINT "OtaConnectionSession_token_storage_check" CHECK (
    ("status" IN ('TOKEN_ISSUED', 'OPENED', 'COMPLETED') AND "tokenFingerprint" IS NOT NULL AND "tokenIssuedAt" IS NOT NULL AND "launchUrlOrigin" IS NOT NULL)
    OR ("status" NOT IN ('TOKEN_ISSUED', 'OPENED', 'COMPLETED'))
  )
);

CREATE UNIQUE INDEX "DistributionGroup_organizationId_platform_key" ON "DistributionGroup"("organizationId", "platform");
CREATE UNIQUE INDEX "DistributionGroup_platform_externalGroupId_key" ON "DistributionGroup"("platform", "externalGroupId");
CREATE INDEX "DistributionGroup_provisioningStatus_updatedAt_idx" ON "DistributionGroup"("provisioningStatus", "updatedAt");
CREATE UNIQUE INDEX "DistributionProperty_propertyId_platform_key" ON "DistributionProperty"("propertyId", "platform");
CREATE UNIQUE INDEX "DistributionProperty_platform_externalPropertyId_key" ON "DistributionProperty"("platform", "externalPropertyId");
CREATE INDEX "DistributionProperty_organizationId_provisioningStatus_idx" ON "DistributionProperty"("organizationId", "provisioningStatus");
CREATE INDEX "DistributionProperty_groupId_idx" ON "DistributionProperty"("groupId");
CREATE UNIQUE INDEX "OtaChannelConnection_propertyId_provider_key" ON "OtaChannelConnection"("propertyId", "provider");
CREATE UNIQUE INDEX "OtaChannelConnection_provider_externalConnectionId_key" ON "OtaChannelConnection"("provider", "externalConnectionId");
CREATE INDEX "OtaChannelConnection_organizationId_status_idx" ON "OtaChannelConnection"("organizationId", "status");
CREATE INDEX "OtaChannelConnection_distributionPropertyId_status_idx" ON "OtaChannelConnection"("distributionPropertyId", "status");
CREATE UNIQUE INDEX "OtaConnectionSession_organizationId_requestKey_key" ON "OtaConnectionSession"("organizationId", "requestKey");
CREATE INDEX "OtaConnectionSession_organizationId_propertyId_status_expir_idx" ON "OtaConnectionSession"("organizationId", "propertyId", "status", "expiresAt");
CREATE INDEX "OtaConnectionSession_otaChannelConnectionId_status_idx" ON "OtaConnectionSession"("otaChannelConnectionId", "status");
CREATE INDEX "OtaConnectionSession_requestedByUserId_requestedAt_idx" ON "OtaConnectionSession"("requestedByUserId", "requestedAt");

ALTER TABLE "DistributionGroup" ADD CONSTRAINT "DistributionGroup_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DistributionProperty" ADD CONSTRAINT "DistributionProperty_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DistributionProperty" ADD CONSTRAINT "DistributionProperty_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DistributionProperty" ADD CONSTRAINT "DistributionProperty_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "DistributionGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "OtaChannelConnection" ADD CONSTRAINT "OtaChannelConnection_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OtaChannelConnection" ADD CONSTRAINT "OtaChannelConnection_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OtaChannelConnection" ADD CONSTRAINT "OtaChannelConnection_distributionPropertyId_fkey" FOREIGN KEY ("distributionPropertyId") REFERENCES "DistributionProperty"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OtaConnectionSession" ADD CONSTRAINT "OtaConnectionSession_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OtaConnectionSession" ADD CONSTRAINT "OtaConnectionSession_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OtaConnectionSession" ADD CONSTRAINT "OtaConnectionSession_otaChannelConnectionId_fkey" FOREIGN KEY ("otaChannelConnectionId") REFERENCES "OtaChannelConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OtaConnectionSession" ADD CONSTRAINT "OtaConnectionSession_requestedByUserId_fkey" FOREIGN KEY ("requestedByUserId") REFERENCES "DashboardUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

COMMIT;
