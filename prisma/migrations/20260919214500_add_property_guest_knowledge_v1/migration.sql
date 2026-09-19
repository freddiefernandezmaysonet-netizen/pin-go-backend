-- Pin AI Property Guest Knowledge V1.
-- Committed for review/certification only. This migration is not applied by this change.

CREATE TABLE "PropertyGuestKnowledge" (
  "id" TEXT NOT NULL,
  "propertyId" TEXT NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "wifi" JSONB,
  "parking" JSONB,
  "arrivalInstructionsEn" TEXT,
  "arrivalInstructionsEs" TEXT,
  "accessInstructionsEn" TEXT,
  "accessInstructionsEs" TEXT,
  "applianceGuides" JSONB,
  "troubleshooting" JSONB,
  "utilities" JSONB,
  "garbageInstructionsEn" TEXT,
  "garbageInstructionsEs" TEXT,
  "checkoutInstructionsEn" TEXT,
  "checkoutInstructionsEs" TEXT,
  "safetyInformation" JSONB,
  "localNotes" JSONB,
  "customFaq" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PropertyGuestKnowledge_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PropertyGuestKnowledge_propertyId_key"
  ON "PropertyGuestKnowledge"("propertyId");

CREATE INDEX "PropertyGuestKnowledge_propertyId_idx"
  ON "PropertyGuestKnowledge"("propertyId");

ALTER TABLE "PropertyGuestKnowledge"
  ADD CONSTRAINT "PropertyGuestKnowledge_propertyId_fkey"
  FOREIGN KEY ("propertyId") REFERENCES "Property"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
