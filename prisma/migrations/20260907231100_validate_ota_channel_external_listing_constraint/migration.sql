-- Validate the listing identity format under a weaker lock than ADD COLUMN.
BEGIN;
SET LOCAL search_path = pg_catalog, public;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15min';

ALTER TABLE "public"."OtaChannelConnection"
  VALIDATE CONSTRAINT "OtaChannelConnection_external_listing_id_check";
COMMIT;
