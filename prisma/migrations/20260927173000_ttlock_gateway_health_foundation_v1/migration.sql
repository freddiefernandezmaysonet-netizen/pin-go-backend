-- Gateway Health V1 foundation.
-- Adds a canonical TTLock gateway entity and an optional lock mapping.
-- Legacy DeviceHealth gateway fields remain in place during the transition.

CREATE TABLE "TtlockGateway" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "ttlockGatewayId" INTEGER NOT NULL,
  "gatewayMac" TEXT,
  "gatewayName" TEXT,
  "gatewayVersion" TEXT,
  "networkName" TEXT,
  "isOnline" BOOLEAN,
  "lastEventAt" TIMESTAMP(3),
  "lastOnlineAt" TIMESTAMP(3),
  "lastOfflineAt" TIMESTAMP(3),
  "source" TEXT,
  "rawPayload" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "TtlockGateway_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "Lock"
ADD COLUMN "ttlockGatewayRecordId" TEXT;

CREATE UNIQUE INDEX "TtlockGateway_organizationId_ttlockGatewayId_key"
ON "TtlockGateway"("organizationId", "ttlockGatewayId");

CREATE INDEX "TtlockGateway_ttlockGatewayId_idx"
ON "TtlockGateway"("ttlockGatewayId");

CREATE INDEX "TtlockGateway_organizationId_isOnline_idx"
ON "TtlockGateway"("organizationId", "isOnline");

CREATE INDEX "TtlockGateway_lastEventAt_idx"
ON "TtlockGateway"("lastEventAt");

CREATE INDEX "Lock_ttlockGatewayRecordId_idx"
ON "Lock"("ttlockGatewayRecordId");

ALTER TABLE "TtlockGateway"
ADD CONSTRAINT "TtlockGateway_organizationId_fkey"
FOREIGN KEY ("organizationId")
REFERENCES "Organization"("id")
ON DELETE CASCADE
ON UPDATE CASCADE;

ALTER TABLE "Lock"
ADD CONSTRAINT "Lock_ttlockGatewayRecordId_fkey"
FOREIGN KEY ("ttlockGatewayRecordId")
REFERENCES "TtlockGateway"("id")
ON DELETE SET NULL
ON UPDATE CASCADE;


-- Backfill gateway-to-lock mappings from already-persisted local telemetry.
-- This performs zero TTLock provider requests and intentionally does NOT
-- backfill TtlockGateway.isOnline; callback state remains canonical.
WITH gateway_telemetry AS (
  SELECT
    dh."organizationId",
    dh."lockId",
    CASE
      WHEN COALESCE(
        dh."rawPayload"->>'gatewayId',
        dh."gatewayRawPayload"->'gateway'->>'gatewayId',
        dh."gatewayRawPayload"->'association'->'list'->0->>'gatewayId'
      ) ~ '^[0-9]+$'
      THEN COALESCE(
        dh."rawPayload"->>'gatewayId',
        dh."gatewayRawPayload"->'gateway'->>'gatewayId',
        dh."gatewayRawPayload"->'association'->'list'->0->>'gatewayId'
      )::INTEGER
      ELSE NULL
    END AS gateway_id
  FROM "DeviceHealth" dh
),
distinct_gateways AS (
  SELECT DISTINCT
    "organizationId",
    gateway_id
  FROM gateway_telemetry
  WHERE gateway_id IS NOT NULL
)
INSERT INTO "TtlockGateway" (
  "id",
  "organizationId",
  "ttlockGatewayId",
  "source",
  "createdAt",
  "updatedAt"
)
SELECT
  'ttgw_' || md5("organizationId" || ':' || gateway_id::TEXT),
  "organizationId",
  gateway_id,
  'LOCAL_TELEMETRY_BACKFILL',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM distinct_gateways
ON CONFLICT ("organizationId", "ttlockGatewayId") DO NOTHING;

WITH gateway_telemetry AS (
  SELECT
    dh."organizationId",
    dh."lockId",
    CASE
      WHEN COALESCE(
        dh."rawPayload"->>'gatewayId',
        dh."gatewayRawPayload"->'gateway'->>'gatewayId',
        dh."gatewayRawPayload"->'association'->'list'->0->>'gatewayId'
      ) ~ '^[0-9]+$'
      THEN COALESCE(
        dh."rawPayload"->>'gatewayId',
        dh."gatewayRawPayload"->'gateway'->>'gatewayId',
        dh."gatewayRawPayload"->'association'->'list'->0->>'gatewayId'
      )::INTEGER
      ELSE NULL
    END AS gateway_id
  FROM "DeviceHealth" dh
)
UPDATE "Lock" AS l
SET "ttlockGatewayRecordId" = tg."id"
FROM gateway_telemetry gt
JOIN "TtlockGateway" tg
  ON tg."organizationId" = gt."organizationId"
 AND tg."ttlockGatewayId" = gt.gateway_id
WHERE l."id" = gt."lockId"
  AND gt.gateway_id IS NOT NULL
  AND l."ttlockGatewayRecordId" IS NULL;
