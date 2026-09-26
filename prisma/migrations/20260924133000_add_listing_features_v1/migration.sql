-- Listing Features V1
-- Additive, canonical property characteristics for faceted discovery and Pin AI.
-- Facts are host-supplied; the search layer must not infer them from prose/photos.

CREATE TYPE "ListingFeatureType" AS ENUM (
  'WOOD_CONSTRUCTION',
  'OCEAN_VIEW',
  'MOUNTAIN_VIEW',
  'WATERFRONT',
  'BEACH_ACCESS',
  'POOL_TABLE',
  'GYM',
  'FIREPLACE',
  'OUTDOOR_GRILL',
  'WORKSPACE',
  'OTHER'
);

CREATE TABLE "PropertyListingFeature" (
  "id" TEXT NOT NULL,
  "listingDetailsId" TEXT NOT NULL,
  "type" "ListingFeatureType" NOT NULL,
  "labelEn" TEXT,
  "labelEs" TEXT,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "PropertyListingFeature_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PropertyListingFeature_listingDetailsId_type_key"
ON "PropertyListingFeature"("listingDetailsId", "type");

CREATE INDEX "PropertyListingFeature_listingDetailsId_isActive_sortOrder_idx"
ON "PropertyListingFeature"("listingDetailsId", "isActive", "sortOrder");

ALTER TABLE "PropertyListingFeature"
ADD CONSTRAINT "PropertyListingFeature_listingDetailsId_fkey"
FOREIGN KEY ("listingDetailsId") REFERENCES "PropertyListingDetails"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
