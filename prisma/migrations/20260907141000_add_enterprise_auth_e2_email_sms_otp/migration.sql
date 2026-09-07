-- Pin&Go Enterprise Authentication E2 — Email + SMS OTP persistence.
-- This migration is committed for review/certification only and is NOT applied by this change.

CREATE TYPE "AuthFactorType" AS ENUM ('PASSKEY', 'TOTP', 'SMS', 'EMAIL');
CREATE TYPE "AuthFactorStatus" AS ENUM ('PENDING', 'VERIFIED', 'DISABLED');
CREATE TYPE "MfaChallengeStatus" AS ENUM ('PENDING', 'VERIFIED', 'EXPIRED', 'LOCKED', 'CONSUMED');
CREATE TYPE "SecurityEventType" AS ENUM (
  'MFA_FACTOR_REGISTERED',
  'MFA_FACTOR_VERIFIED',
  'MFA_FACTOR_DISABLED',
  'MFA_CHALLENGE_CREATED',
  'MFA_CHALLENGE_SENT',
  'MFA_CHALLENGE_VERIFIED',
  'MFA_CHALLENGE_FAILED',
  'MFA_CHALLENGE_LOCKED',
  'MFA_CHALLENGE_EXPIRED'
);

CREATE TABLE "AuthFactor" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "type" "AuthFactorType" NOT NULL,
  "status" "AuthFactorStatus" NOT NULL DEFAULT 'PENDING',
  "label" TEXT,
  "destination" TEXT,
  "verifiedAt" TIMESTAMP(3),
  "lastUsedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AuthFactor_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MfaChallenge" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "factorId" TEXT NOT NULL,
  "purpose" TEXT NOT NULL DEFAULT 'LOGIN_MFA',
  "challengeTokenHash" TEXT NOT NULL,
  "otpHash" TEXT NOT NULL,
  "status" "MfaChallengeStatus" NOT NULL DEFAULT 'PENDING',
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "maxAttempts" INTEGER NOT NULL DEFAULT 5,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "lastSentAt" TIMESTAMP(3),
  "verifiedAt" TIMESTAMP(3),
  "consumedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MfaChallenge_pkey" PRIMARY KEY ("id")
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

CREATE UNIQUE INDEX "AuthFactor_userId_type_destination_key" ON "AuthFactor"("userId", "type", "destination");
CREATE UNIQUE INDEX "MfaChallenge_challengeTokenHash_key" ON "MfaChallenge"("challengeTokenHash");
CREATE INDEX "AuthFactor_userId_status_idx" ON "AuthFactor"("userId", "status");
CREATE INDEX "AuthFactor_userId_type_idx" ON "AuthFactor"("userId", "type");
CREATE INDEX "MfaChallenge_userId_status_idx" ON "MfaChallenge"("userId", "status");
CREATE INDEX "MfaChallenge_factorId_status_idx" ON "MfaChallenge"("factorId", "status");
CREATE INDEX "MfaChallenge_expiresAt_idx" ON "MfaChallenge"("expiresAt");
CREATE INDEX "SecurityEvent_userId_createdAt_idx" ON "SecurityEvent"("userId", "createdAt");
CREATE INDEX "SecurityEvent_organizationId_createdAt_idx" ON "SecurityEvent"("organizationId", "createdAt");
CREATE INDEX "SecurityEvent_type_createdAt_idx" ON "SecurityEvent"("type", "createdAt");

ALTER TABLE "AuthFactor" ADD CONSTRAINT "AuthFactor_userId_fkey" FOREIGN KEY ("userId") REFERENCES "DashboardUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MfaChallenge" ADD CONSTRAINT "MfaChallenge_userId_fkey" FOREIGN KEY ("userId") REFERENCES "DashboardUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MfaChallenge" ADD CONSTRAINT "MfaChallenge_factorId_fkey" FOREIGN KEY ("factorId") REFERENCES "AuthFactor"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SecurityEvent" ADD CONSTRAINT "SecurityEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "DashboardUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SecurityEvent" ADD CONSTRAINT "SecurityEvent_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "AuthFactor" ADD CONSTRAINT "AuthFactor_destination_required_check" CHECK (
  ("type" IN ('EMAIL', 'SMS') AND "destination" IS NOT NULL) OR
  ("type" NOT IN ('EMAIL', 'SMS'))
);
ALTER TABLE "MfaChallenge" ADD CONSTRAINT "MfaChallenge_attemptCount_check" CHECK ("attemptCount" >= 0);
ALTER TABLE "MfaChallenge" ADD CONSTRAINT "MfaChallenge_maxAttempts_check" CHECK ("maxAttempts" BETWEEN 1 AND 10);
