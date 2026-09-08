-- Durable Channex channel lifecycle watermark for ordered, fenced OTA evidence.
-- Additive only: existing connections remain unwatermarked until fresh evidence arrives.
BEGIN;
SET LOCAL search_path = pg_catalog, public;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "public"."OtaChannelConnection"
  ADD COLUMN "lastLifecycleOccurredAt" TIMESTAMP(3),
  ADD COLUMN "lastLifecycleOccurredAtMicros" BIGINT,
  ADD COLUMN "lastLifecycleEventType" VARCHAR(40),
  ADD COLUMN "lastLifecycleEventPrecedence" INTEGER,
  ADD COLUMN "channelAuthorizationVerifiedAt" TIMESTAMP(3),
  ADD COLUMN "lastChannelActivatedAt" TIMESTAMP(3),
  ADD COLUMN "readinessRevision" INTEGER NOT NULL DEFAULT 0;
COMMIT;
