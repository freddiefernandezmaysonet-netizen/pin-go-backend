-- Additive only: durable recovery lease, initially unclaimed for all rows.
-- No existing call status, guest, property, Stripe or Channex data is modified.
ALTER TABLE "SalesVoiceCall"
  ADD COLUMN "recoveryLeaseOwner" VARCHAR(80),
  ADD COLUMN "recoveryLeaseUntil" TIMESTAMP(3),
  ADD COLUMN "recoveryLeaseEpoch" INTEGER NOT NULL DEFAULT 0;
