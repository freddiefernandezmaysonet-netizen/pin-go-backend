-- Listing Experience Tags V1
-- Host-defined discovery labels such as "Romantic retreat" or "Couples retreat".
-- These are intentionally separate from objective ListingFeatureType facts.

CREATE TABLE "PropertyListingExperienceTag" (
  "id" TEXT NOT NULL,
  "listingDetailsId" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "PropertyListingExperienceTag_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PropertyListingExperienceTag_listingDetailsId_slug_key"
ON "PropertyListingExperienceTag"("listingDetailsId", "slug");

CREATE INDEX "PropertyListingExperienceTag_listingDetailsId_isActive_sortOrder_idx"
ON "PropertyListingExperienceTag"("listingDetailsId", "isActive", "sortOrder");

ALTER TABLE "PropertyListingExperienceTag"
ADD CONSTRAINT "PropertyListingExperienceTag_listingDetailsId_fkey"
FOREIGN KEY ("listingDetailsId") REFERENCES "PropertyListingDetails"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
