-- DESIGN ONLY — NOT A PRISMA MIGRATION.
-- Pin&Go Enterprise Authentication E1 persistence blueprint.
-- This file MUST NOT be executed against any environment. A later authorized slice
-- must translate the approved design into prisma/schema.prisma + a reviewed migration.

CREATE TYPE "AuthFactorType" AS ENUM ('PASSKEY', 'TOTP', 'SMS', 'EMAIL');
CREATE TYPE "AuthFactorStatus" AS ENUM ('PENDING', 'VERIFIED', 'DISABLED');
CREATE TYPE "MfaChallengeStatus" AS ENUM ('PENDING', 'VERIFIED', 'EXPIRED', 'LOCKED', 'CONSUMED');
CREATE TYPE "SecurityEventType" AS ENUM (
  'LOGIN_PASSWORD_ACCEPTED', 'LOGIN_SUCCESS', 'LOGIN_FAILED',
  'MFA_CHALLENGE_CREATED', 'MFA_CHALLENGE_VERIFIED', 'MFA_CHALLENGE_FAILED',
  'MFA_FACTOR_REGISTERED', 'MFA_FACTOR_DISABLED', 'PASSKEY_REGISTERED',
  'TRUSTED_DEVICE_CREATED', 'TRUSTED_DEVICE_REVOKED', 'RECOVERY_CODE_USED'
);

CREATE TABLE "AuthFactor" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "type" "AuthFactorType" NOT NULL,
  "status" "AuthFactorStatus" NOT NULL DEFAULT 'PENDING',
  "label" TEXT,
  "destination" TEXT,
  "secretCiphertext" TEXT,
  "verifiedAt" TIMESTAMP(3),
  "lastUsedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AuthFactor_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MfaChallenge" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "factorId" TEXT,
  "challengeTokenHash" TEXT NOT NULL,
  "otpHash" TEXT,
  "status" "MfaChallengeStatus" NOT NULL DEFAULT 'PENDING',
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "maxAttempts" INTEGER NOT NULL DEFAULT 5,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "verifiedAt" TIMESTAMP(3),
  "consumedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MfaChallenge_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PasskeyCredential" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "factorId" TEXT NOT NULL,
  "credentialId" TEXT NOT NULL,
  "publicKey" TEXT NOT NULL,
  "counter" BIGINT NOT NULL DEFAULT 0,
  "transports" JSONB,
  "backedUp" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastUsedAt" TIMESTAMP(3),
  CONSTRAINT "PasskeyCredential_pkey" PRIMARY KEY ("id")
);

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
  CONSTRAINT "TrustedDevice_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RecoveryCode" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "codeHash" TEXT NOT NULL,
  "usedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RecoveryCode_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SecurityEvent" (
  "id" TEXT NOT NULL,
  "userId" TEXT,
  "organizationId" TEXT,
  "type" "SecurityEventType" NOT NULL,
  "ipHash" TEXT,
  "userAgent" TEXT,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SecurityEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MfaChallenge_challengeTokenHash_key" ON "MfaChallenge"("challengeTokenHash");
CREATE UNIQUE INDEX "PasskeyCredential_factorId_key" ON "PasskeyCredential"("factorId");
CREATE UNIQUE INDEX "PasskeyCredential_credentialId_key" ON "PasskeyCredential"("credentialId");
CREATE UNIQUE INDEX "TrustedDevice_tokenHash_key" ON "TrustedDevice"("tokenHash");
CREATE UNIQUE INDEX "RecoveryCode_codeHash_key" ON "RecoveryCode"("codeHash");
CREATE INDEX "AuthFactor_userId_status_idx" ON "AuthFactor"("userId", "status");
CREATE INDEX "AuthFactor_userId_type_idx" ON "AuthFactor"("userId", "type");
CREATE INDEX "MfaChallenge_userId_status_idx" ON "MfaChallenge"("userId", "status");
CREATE INDEX "MfaChallenge_expiresAt_idx" ON "MfaChallenge"("expiresAt");
CREATE INDEX "PasskeyCredential_userId_idx" ON "PasskeyCredential"("userId");
CREATE INDEX "TrustedDevice_userId_revokedAt_idx" ON "TrustedDevice"("userId", "revokedAt");
CREATE INDEX "TrustedDevice_expiresAt_idx" ON "TrustedDevice"("expiresAt");
CREATE INDEX "RecoveryCode_userId_usedAt_idx" ON "RecoveryCode"("userId", "usedAt");
CREATE INDEX "SecurityEvent_userId_createdAt_idx" ON "SecurityEvent"("userId", "createdAt");
CREATE INDEX "SecurityEvent_organizationId_createdAt_idx" ON "SecurityEvent"("organizationId", "createdAt");
CREATE INDEX "SecurityEvent_type_createdAt_idx" ON "SecurityEvent"("type", "createdAt");

ALTER TABLE "AuthFactor" ADD CONSTRAINT "AuthFactor_userId_fkey" FOREIGN KEY ("userId") REFERENCES "DashboardUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MfaChallenge" ADD CONSTRAINT "MfaChallenge_userId_fkey" FOREIGN KEY ("userId") REFERENCES "DashboardUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MfaChallenge" ADD CONSTRAINT "MfaChallenge_factorId_fkey" FOREIGN KEY ("factorId") REFERENCES "AuthFactor"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PasskeyCredential" ADD CONSTRAINT "PasskeyCredential_userId_fkey" FOREIGN KEY ("userId") REFERENCES "DashboardUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PasskeyCredential" ADD CONSTRAINT "PasskeyCredential_factorId_fkey" FOREIGN KEY ("factorId") REFERENCES "AuthFactor"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TrustedDevice" ADD CONSTRAINT "TrustedDevice_userId_fkey" FOREIGN KEY ("userId") REFERENCES "DashboardUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RecoveryCode" ADD CONSTRAINT "RecoveryCode_userId_fkey" FOREIGN KEY ("userId") REFERENCES "DashboardUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SecurityEvent" ADD CONSTRAINT "SecurityEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "DashboardUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SecurityEvent" ADD CONSTRAINT "SecurityEvent_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "MfaChallenge" ADD CONSTRAINT "MfaChallenge_attemptCount_check" CHECK ("attemptCount" >= 0);
ALTER TABLE "MfaChallenge" ADD CONSTRAINT "MfaChallenge_maxAttempts_check" CHECK ("maxAttempts" BETWEEN 1 AND 10);
