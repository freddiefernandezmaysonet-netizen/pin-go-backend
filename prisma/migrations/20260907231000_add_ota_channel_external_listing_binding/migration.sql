-- Stable OTA listing identity observed through the exact Channex channel mapping.
-- Additive only: existing connections remain unbound until canonical verification.
BEGIN;
SET LOCAL search_path = pg_catalog, public;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "public"."OtaChannelConnection"
  ADD COLUMN "externalListingId" VARCHAR(255),
  ADD CONSTRAINT "OtaChannelConnection_external_listing_id_check"
  CHECK (
    "externalListingId" IS NULL
    OR "externalListingId" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$'
  ) NOT VALID;
COMMIT;
