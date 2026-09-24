-- Property Listing Details V1
-- Additive only. Existing properties remain valid with no listing-details row.

CREATE TYPE "ListingAccommodationType" AS ENUM ('ENTIRE_PLACE', 'PRIVATE_ROOM', 'SHARED_ROOM');
CREATE TYPE "ListingPermissionState" AS ENUM ('ALLOWED', 'NOT_ALLOWED', 'UNKNOWN');
CREATE TYPE "ListingTruthState" AS ENUM ('YES', 'NO', 'UNKNOWN');
CREATE TYPE "ListingParkingType" AS ENUM ('PRIVATE', 'GARAGE', 'DRIVEWAY', 'STREET', 'LOT', 'OTHER');
CREATE TYPE "ListingParkingFeeType" AS ENUM ('FREE', 'PAID', 'UNKNOWN');
CREATE TYPE "ListingSleepingAreaKind" AS ENUM ('BEDROOM', 'SLEEPING_AREA');
CREATE TYPE "ListingBedType" AS ENUM ('KING', 'QUEEN', 'DOUBLE', 'SINGLE', 'BUNK', 'SOFA_BED', 'FUTON', 'CRIB', 'OTHER');
CREATE TYPE "ListingSharedSpaceType" AS ENUM ('POOL', 'HOT_TUB', 'KITCHEN', 'PATIO', 'YARD', 'LIVING_ROOM', 'LAUNDRY', 'OTHER');
CREATE TYPE "ListingSafetyConsiderationType" AS ENUM ('POOL', 'HOT_TUB', 'WATERFRONT', 'HEIGHTS', 'STAIRS', 'OTHER');

CREATE TABLE "PropertyListingDetails" (
    "id" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "accommodationType" "ListingAccommodationType",
    "bedroomCount" INTEGER,
    "fullBathroomCount" INTEGER,
    "halfBathroomCount" INTEGER,
    "minimumPrimaryBookingGuestAge" INTEGER,
    "childrenPolicy" "ListingPermissionState" NOT NULL DEFAULT 'UNKNOWN',
    "infantsPolicy" "ListingPermissionState" NOT NULL DEFAULT 'UNKNOWN',
    "adultsOnly" "ListingTruthState" NOT NULL DEFAULT 'UNKNOWN',
    "petsPolicy" "ListingPermissionState" NOT NULL DEFAULT 'UNKNOWN',
    "smokingPolicy" "ListingPermissionState" NOT NULL DEFAULT 'UNKNOWN',
    "vapingPolicy" "ListingPermissionState" NOT NULL DEFAULT 'UNKNOWN',
    "eventsPolicy" "ListingPermissionState" NOT NULL DEFAULT 'UNKNOWN',
    "unregisteredVisitorsPolicy" "ListingPermissionState" NOT NULL DEFAULT 'UNKNOWN',
    "quietHoursEnabled" "ListingTruthState" NOT NULL DEFAULT 'UNKNOWN',
    "quietHoursStart" VARCHAR(5),
    "quietHoursEnd" VARCHAR(5),
    "parkingAvailability" "ListingTruthState" NOT NULL DEFAULT 'UNKNOWN',
    "parkingType" "ListingParkingType",
    "parkingFeeType" "ListingParkingFeeType",
    "parkingVehicleCapacity" INTEGER,
    "smokeDetector" "ListingTruthState" NOT NULL DEFAULT 'UNKNOWN',
    "carbonMonoxideDetector" "ListingTruthState" NOT NULL DEFAULT 'UNKNOWN',
    "exteriorSecurityCameras" "ListingTruthState" NOT NULL DEFAULT 'UNKNOWN',
    "exteriorSecurityCamerasDisclosureEn" TEXT,
    "exteriorSecurityCamerasDisclosureEs" TEXT,
    "animalsOnProperty" "ListingTruthState" NOT NULL DEFAULT 'UNKNOWN',
    "animalsOnPropertyDisclosureEn" TEXT,
    "animalsOnPropertyDisclosureEs" TEXT,
    "stepFreeEntrance" "ListingTruthState" NOT NULL DEFAULT 'UNKNOWN',
    "entranceStepCount" INTEGER,
    "elevatorAvailable" "ListingTruthState" NOT NULL DEFAULT 'UNKNOWN',
    "accessibleParking" "ListingTruthState" NOT NULL DEFAULT 'UNKNOWN',
    "stepFreeBedroomAccess" "ListingTruthState" NOT NULL DEFAULT 'UNKNOWN',
    "stepFreeBathroomAccess" "ListingTruthState" NOT NULL DEFAULT 'UNKNOWN',
    "stepFreeShower" "ListingTruthState" NOT NULL DEFAULT 'UNKNOWN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PropertyListingDetails_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PropertyListingSleepingArea" (
    "id" TEXT NOT NULL,
    "listingDetailsId" TEXT NOT NULL,
    "kind" "ListingSleepingAreaKind" NOT NULL DEFAULT 'BEDROOM',
    "nameEn" TEXT,
    "nameEs" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PropertyListingSleepingArea_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PropertyListingBed" (
    "id" TEXT NOT NULL,
    "sleepingAreaId" TEXT NOT NULL,
    "type" "ListingBedType" NOT NULL,
    "quantity" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PropertyListingBed_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PropertyListingSharedSpace" (
    "id" TEXT NOT NULL,
    "listingDetailsId" TEXT NOT NULL,
    "type" "ListingSharedSpaceType" NOT NULL,
    "labelEn" TEXT,
    "labelEs" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PropertyListingSharedSpace_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PropertyListingSafetyConsideration" (
    "id" TEXT NOT NULL,
    "listingDetailsId" TEXT NOT NULL,
    "type" "ListingSafetyConsiderationType" NOT NULL,
    "descriptionEn" TEXT,
    "descriptionEs" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PropertyListingSafetyConsideration_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PropertyListingAdditionalConsideration" (
    "id" TEXT NOT NULL,
    "listingDetailsId" TEXT NOT NULL,
    "titleEn" TEXT,
    "titleEs" TEXT,
    "descriptionEn" TEXT,
    "descriptionEs" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PropertyListingAdditionalConsideration_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PropertyListingDetails_propertyId_key" ON "PropertyListingDetails"("propertyId");
CREATE INDEX "PropertyListingDetails_propertyId_version_idx" ON "PropertyListingDetails"("propertyId", "version");
CREATE INDEX "PropertyListingSleepingArea_listingDetailsId_sortOrder_idx" ON "PropertyListingSleepingArea"("listingDetailsId", "sortOrder");
CREATE INDEX "PropertyListingBed_sleepingAreaId_idx" ON "PropertyListingBed"("sleepingAreaId");
CREATE INDEX "PropertyListingSharedSpace_listingDetailsId_sortOrder_idx" ON "PropertyListingSharedSpace"("listingDetailsId", "sortOrder");
CREATE INDEX "PropertyListingSafetyConsideration_listingDetailsId_isActive_sortOrder_idx" ON "PropertyListingSafetyConsideration"("listingDetailsId", "isActive", "sortOrder");
CREATE INDEX "PropertyListingAdditionalConsideration_listingDetailsId_isActive_sortOrder_idx" ON "PropertyListingAdditionalConsideration"("listingDetailsId", "isActive", "sortOrder");

ALTER TABLE "PropertyListingDetails"
ADD CONSTRAINT "PropertyListingDetails_propertyId_fkey"
FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PropertyListingSleepingArea"
ADD CONSTRAINT "PropertyListingSleepingArea_listingDetailsId_fkey"
FOREIGN KEY ("listingDetailsId") REFERENCES "PropertyListingDetails"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PropertyListingBed"
ADD CONSTRAINT "PropertyListingBed_sleepingAreaId_fkey"
FOREIGN KEY ("sleepingAreaId") REFERENCES "PropertyListingSleepingArea"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PropertyListingSharedSpace"
ADD CONSTRAINT "PropertyListingSharedSpace_listingDetailsId_fkey"
FOREIGN KEY ("listingDetailsId") REFERENCES "PropertyListingDetails"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PropertyListingSafetyConsideration"
ADD CONSTRAINT "PropertyListingSafetyConsideration_listingDetailsId_fkey"
FOREIGN KEY ("listingDetailsId") REFERENCES "PropertyListingDetails"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PropertyListingAdditionalConsideration"
ADD CONSTRAINT "PropertyListingAdditionalConsideration_listingDetailsId_fkey"
FOREIGN KEY ("listingDetailsId") REFERENCES "PropertyListingDetails"("id") ON DELETE CASCADE ON UPDATE CASCADE;
