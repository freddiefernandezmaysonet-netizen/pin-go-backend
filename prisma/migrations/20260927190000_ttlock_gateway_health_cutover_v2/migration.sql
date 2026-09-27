-- TTLock Gateway Health Cutover V2.
-- Separates lock↔gateway freshness from the physical gateway state.

ALTER TABLE "DeviceHealth"
ADD COLUMN "lockLinkState" TEXT,
ADD COLUMN "lockLinkLastSeenAt" TIMESTAMP(3);

CREATE INDEX "DeviceHealth_lockLinkState_idx"
ON "DeviceHealth"("lockLinkState");

-- Backfill only from local telemetry already persisted by Pin&Go.
-- No TTLock provider request is performed.
UPDATE "DeviceHealth"
SET
  "lockLinkState" = COALESCE(
    "rawPayload"->>'lockLinkState',
    "lockLinkState"
  ),
  "lockLinkLastSeenAt" = CASE
    WHEN ("rawPayload"->>'gatewayRssiUpdatedAt') ~ '^\d{4}-\d{2}-\d{2}T'
      THEN (("rawPayload"->>'gatewayRssiUpdatedAt')::TIMESTAMPTZ AT TIME ZONE 'UTC')::TIMESTAMP(3)
    ELSE "lockLinkLastSeenAt"
  END
WHERE
  "rawPayload" ? 'lockLinkState'
  OR "rawPayload" ? 'gatewayRssiUpdatedAt';
