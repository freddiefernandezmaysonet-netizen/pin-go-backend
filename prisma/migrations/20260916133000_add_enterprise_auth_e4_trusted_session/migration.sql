-- Pin&Go Enterprise Authentication E4 — Trusted Device + Auth Session persistence.
-- This migration is committed for review/certification only and is NOT applied by this change.

ALTER TYPE "SecurityEventType" ADD VALUE IF NOT EXISTS 'TRUSTED_DEVICE_CREATED';
ALTER TYPE "SecurityEventType" ADD VALUE IF NOT EXISTS 'TRUSTED_DEVICE_REVOKED';
ALTER TYPE "SecurityEventType" ADD VALUE IF NOT EXISTS 'AUTH_SESSION_CREATED';
ALTER TYPE "SecurityEventType" ADD VALUE IF NOT EXISTS 'AUTH_SESSION_REVOKED';
ALTER TYPE "SecurityEventType" ADD VALUE IF NOT EXISTS 'AUTH_SESSION_EXPIRED';

CREATE TABLE "TrustedDevice" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "label" TEXT,
  "userAgent" TEXT,
  "lastIpHash" TEXT,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "lastUsedAt" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TrustedDevice_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AuthSession" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "tokenVersion" INTEGER NOT NULL,
  "authenticatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "absoluteExpiresAt" TIMESTAMP(3) NOT NULL,
  "trustedDeviceId" TEXT,
  "userAgent" TEXT,
  "lastIpHash" TEXT,
  "revokedAt" TIMESTAMP(3),
  "revokeReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AuthSession_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TrustedDevice_tokenHash_key" ON "TrustedDevice"("tokenHash");
CREATE INDEX "TrustedDevice_userId_revokedAt_idx" ON "TrustedDevice"("userId", "revokedAt");
CREATE INDEX "TrustedDevice_expiresAt_idx" ON "TrustedDevice"("expiresAt");

CREATE INDEX "AuthSession_userId_revokedAt_idx" ON "AuthSession"("userId", "revokedAt");
CREATE INDEX "AuthSession_organizationId_revokedAt_idx" ON "AuthSession"("organizationId", "revokedAt");
CREATE INDEX "AuthSession_absoluteExpiresAt_idx" ON "AuthSession"("absoluteExpiresAt");
CREATE INDEX "AuthSession_lastActivityAt_idx" ON "AuthSession"("lastActivityAt");
CREATE INDEX "AuthSession_trustedDeviceId_idx" ON "AuthSession"("trustedDeviceId");

ALTER TABLE "TrustedDevice"
  ADD CONSTRAINT "TrustedDevice_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "DashboardUser"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AuthSession"
  ADD CONSTRAINT "AuthSession_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "DashboardUser"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AuthSession"
  ADD CONSTRAINT "AuthSession_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AuthSession"
  ADD CONSTRAINT "AuthSession_trustedDeviceId_fkey"
  FOREIGN KEY ("trustedDeviceId") REFERENCES "TrustedDevice"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "TrustedDevice"
  ADD CONSTRAINT "TrustedDevice_expiresAt_after_createdAt_check"
  CHECK ("expiresAt" > "createdAt");

ALTER TABLE "AuthSession"
  ADD CONSTRAINT "AuthSession_absoluteExpiresAt_after_authenticatedAt_check"
  CHECK ("absoluteExpiresAt" > "authenticatedAt");

ALTER TABLE "AuthSession"
  ADD CONSTRAINT "AuthSession_lastActivityAt_after_authenticatedAt_check"
  CHECK ("lastActivityAt" >= "authenticatedAt");
