-- Additive, nullable Live SIP session control/usage evidence only.
-- No existing reservation, guest, distribution, sales records are modified.
ALTER TABLE "SalesVoiceCall"
  ADD COLUMN "lastUsageSeconds" DOUBLE PRECISION,
  ADD COLUMN "usageObservedAt" TIMESTAMP(3),
  ADD COLUMN "finalUsageSeconds" DOUBLE PRECISION,
  ADD COLUMN "finalizedAt" TIMESTAMP(3),
  ADD COLUMN "closeReason" VARCHAR(40),
  ADD COLUMN "hangupClaimedAt" TIMESTAMP(3),
  ADD COLUMN "hangupAcknowledgedAt" TIMESTAMP(3);
