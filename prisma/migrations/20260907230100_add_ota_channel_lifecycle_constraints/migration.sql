-- Install lifecycle constraints without scanning under ACCESS EXCLUSIVE.
BEGIN;
SET LOCAL search_path = pg_catalog, public;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "public"."OtaChannelConnection"
  ADD CONSTRAINT "OtaChannelConnection_lifecycle_watermark_check"
  CHECK (
    (
      "lastLifecycleOccurredAt" IS NULL
      AND "lastLifecycleOccurredAtMicros" IS NULL
      AND "lastLifecycleEventType" IS NULL
      AND "lastLifecycleEventPrecedence" IS NULL
      AND "channelAuthorizationVerifiedAt" IS NULL
      AND "lastChannelActivatedAt" IS NULL
    )
    OR
    (
      "lastLifecycleOccurredAt" IS NOT NULL
      AND "lastLifecycleOccurredAtMicros" IS NOT NULL
      AND "lastLifecycleEventType" IS NOT NULL
      AND "lastLifecycleEventPrecedence" IS NOT NULL
      AND "lastLifecycleOccurredAt" >= TIMESTAMP '1970-01-01 00:00:00'
      AND "lastLifecycleOccurredAtMicros" >= 0
      AND (
        ("lastLifecycleEventType" = 'new_channel' AND "lastLifecycleEventPrecedence" = 10)
        OR ("lastLifecycleEventType" = 'updated_channel' AND "lastLifecycleEventPrecedence" = 20)
        OR ("lastLifecycleEventType" = 'activate_channel' AND "lastLifecycleEventPrecedence" = 30)
        OR ("lastLifecycleEventType" = 'deactivate_channel' AND "lastLifecycleEventPrecedence" = 40)
        OR ("lastLifecycleEventType" = 'disconnect_listing' AND "lastLifecycleEventPrecedence" = 50)
        OR ("lastLifecycleEventType" = 'disconnect_channel' AND "lastLifecycleEventPrecedence" = 60)
      )
      AND "lastLifecycleOccurredAtMicros" / 1000 =
        FLOOR(EXTRACT(EPOCH FROM "lastLifecycleOccurredAt") * 1000)::BIGINT
      AND (
        "channelAuthorizationVerifiedAt" IS NULL
        OR "channelAuthorizationVerifiedAt" <= "lastLifecycleOccurredAt"
      )
      AND (
        "lastChannelActivatedAt" IS NULL
        OR "lastChannelActivatedAt" <= "lastLifecycleOccurredAt"
      )
      AND (
        "lastChannelActivatedAt" IS NULL
        OR "channelAuthorizationVerifiedAt" IS NOT NULL
      )
    )
  ) NOT VALID;

ALTER TABLE "public"."OtaChannelConnection"
  ADD CONSTRAINT "OtaChannelConnection_readiness_revision_check"
  CHECK ("readinessRevision" >= 0) NOT VALID;
COMMIT;
