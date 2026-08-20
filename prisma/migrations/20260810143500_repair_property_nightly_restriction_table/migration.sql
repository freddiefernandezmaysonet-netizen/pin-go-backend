-- Forward-only repair for environments where the earlier migration name was
-- recorded with different SQL before PropertyNightlyRestriction was created.
-- This migration is intentionally idempotent for environments where the table
-- already exists with the expected shape.

CREATE TABLE IF NOT EXISTS "PropertyNightlyRestriction" (
  "id" TEXT NOT NULL,
  "propertyId" TEXT NOT NULL,
  "date" TIMESTAMP(3) NOT NULL,
  "minimumNights" INTEGER,
  "maximumNights" INTEGER,
  "source" TEXT NOT NULL DEFAULT 'MANUAL',
  "reason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "PropertyNightlyRestriction_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "PropertyNightlyRestriction_propertyId_date_key"
ON "PropertyNightlyRestriction"("propertyId", "date");

CREATE INDEX IF NOT EXISTS "PropertyNightlyRestriction_propertyId_date_idx"
ON "PropertyNightlyRestriction"("propertyId", "date");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'PropertyNightlyRestriction_propertyId_fkey'
  ) THEN
    ALTER TABLE "PropertyNightlyRestriction"
    ADD CONSTRAINT "PropertyNightlyRestriction_propertyId_fkey"
    FOREIGN KEY ("propertyId") REFERENCES "Property"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;
