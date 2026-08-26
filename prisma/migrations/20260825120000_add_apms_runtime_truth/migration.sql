-- E13: durable APMS runtime truth for Guest Journey and Mission Control.
-- Additive only. No existing rows are modified.

CREATE TYPE "ApmsRuntimeStatus" AS ENUM (
  'OFF',
  'STARTING',
  'ACTIVE',
  'BLOCKED',
  'ERROR'
);

CREATE TYPE "ApmsRuntimePreflightStatus" AS ENUM (
  'NOT_REQUIRED',
  'PENDING',
  'PASSED',
  'FAILED'
);

CREATE TABLE "ApmsRuntimeState" (
  "id" TEXT NOT NULL,
  "runtimeKey" TEXT NOT NULL,
  "runtimeName" TEXT NOT NULL,
  "environment" TEXT NOT NULL,
  "serviceName" TEXT NOT NULL,
  "instanceId" TEXT NOT NULL,
  "bootId" TEXT NOT NULL,
  "deploymentSha" TEXT,
  "deploymentId" TEXT,
  "controlPlaneVersion" TEXT,
  "activationProfile" TEXT,
  "enabledStages" JSONB NOT NULL,
  "configFingerprint" VARCHAR(64) NOT NULL,
  "scopeFingerprint" VARCHAR(64) NOT NULL,
  "organizationScopeHashes" JSONB NOT NULL,
  "propertyScopeHashes" JSONB NOT NULL,
  "organizationScopeCount" INTEGER NOT NULL DEFAULT 0,
  "propertyScopeCount" INTEGER NOT NULL DEFAULT 0,
  "status" "ApmsRuntimeStatus" NOT NULL DEFAULT 'STARTING',
  "preflightStatus" "ApmsRuntimePreflightStatus" NOT NULL DEFAULT 'PENDING',
  "lastPreflightAt" TIMESTAMP(3),
  "lastPreflightErrorCode" TEXT,
  "lastPreflightErrorMessage" TEXT,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastHeartbeatAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "operationalIssueId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ApmsRuntimeState_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ApmsRuntimeState_runtimeKey_key"
  ON "ApmsRuntimeState"("runtimeKey");

CREATE UNIQUE INDEX "ApmsRuntimeState_runtimeName_environment_serviceName_bootId_key"
  ON "ApmsRuntimeState"("runtimeName", "environment", "serviceName", "bootId");

CREATE INDEX "ApmsRuntimeState_runtimeName_environment_serviceName_lastHeartbeatAt_idx"
  ON "ApmsRuntimeState"("runtimeName", "environment", "serviceName", "lastHeartbeatAt");

CREATE INDEX "ApmsRuntimeState_runtimeName_environment_status_lastHeartbeatAt_idx"
  ON "ApmsRuntimeState"("runtimeName", "environment", "status", "lastHeartbeatAt");

CREATE INDEX "ApmsRuntimeState_configFingerprint_lastHeartbeatAt_idx"
  ON "ApmsRuntimeState"("configFingerprint", "lastHeartbeatAt");

CREATE INDEX "ApmsRuntimeState_scopeFingerprint_lastHeartbeatAt_idx"
  ON "ApmsRuntimeState"("scopeFingerprint", "lastHeartbeatAt");

CREATE INDEX "ApmsRuntimeState_bootId_idx"
  ON "ApmsRuntimeState"("bootId");

CREATE INDEX "ApmsRuntimeState_operationalIssueId_idx"
  ON "ApmsRuntimeState"("operationalIssueId");

ALTER TABLE "ApmsRuntimeState"
  ADD CONSTRAINT "ApmsRuntimeState_operationalIssueId_fkey"
  FOREIGN KEY ("operationalIssueId") REFERENCES "OperationalIssue"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
