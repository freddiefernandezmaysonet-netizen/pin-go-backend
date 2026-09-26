-- Listing Property Type V1
-- Additive taxonomy for physical property form. This remains independent from
-- accommodationType (entire place/private room/shared room).

CREATE TYPE "ListingPropertyType" AS ENUM (
  'HOUSE',
  'APARTMENT',
  'CONDO',
  'CABIN',
  'COTTAGE',
  'VILLA',
  'TOWNHOUSE',
  'BUNGALOW',
  'LOFT',
  'STUDIO',
  'GUESTHOUSE',
  'FARM_STAY',
  'OTHER'
);

ALTER TABLE "PropertyListingDetails"
ADD COLUMN "propertyType" "ListingPropertyType";
