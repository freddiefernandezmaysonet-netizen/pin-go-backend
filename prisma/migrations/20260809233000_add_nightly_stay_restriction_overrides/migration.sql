CREATE TABLE "PropertyNightlyRestriction" (
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

CREATE UNIQUE INDEX "PropertyNightlyRestriction_propertyId_date_key"
ON "PropertyNightlyRestriction"("propertyId", "date");

CREATE INDEX "PropertyNightlyRestriction_propertyId_date_idx"
ON "PropertyNightlyRestriction"("propertyId", "date");

ALTER TABLE "PropertyNightlyRestriction"
ADD CONSTRAINT "PropertyNightlyRestriction_propertyId_fkey"
FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE CASCADE ON UPDATE CASCADE;
