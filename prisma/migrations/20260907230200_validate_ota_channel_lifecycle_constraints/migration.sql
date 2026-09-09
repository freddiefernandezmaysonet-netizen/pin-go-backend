-- Validate lifecycle constraints under a weaker lock than ADD COLUMN.
BEGIN;
SET LOCAL search_path = pg_catalog, public;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15min';

ALTER TABLE "public"."OtaChannelConnection"
  VALIDATE CONSTRAINT "OtaChannelConnection_lifecycle_watermark_check";
ALTER TABLE "public"."OtaChannelConnection"
  VALIDATE CONSTRAINT "OtaChannelConnection_readiness_revision_check";
COMMIT;
