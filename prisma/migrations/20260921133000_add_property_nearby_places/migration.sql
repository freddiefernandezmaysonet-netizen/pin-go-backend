-- CreateEnum
CREATE TYPE "NearbyPlaceCategory" AS ENUM ('BEACH', 'RESTAURANT', 'ATTRACTION', 'NATURE', 'SHOPPING', 'NIGHTLIFE', 'CULTURE', 'OTHER');

-- CreateTable
CREATE TABLE "PropertyNearbyPlace" (
    "id" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" "NearbyPlaceCategory" NOT NULL DEFAULT 'OTHER',
    "description" TEXT,
    "distanceText" TEXT,
    "travelTimeMinutes" INTEGER,
    "latitude" DECIMAL(10,7),
    "longitude" DECIMAL(10,7),
    "googleMapsUrl" TEXT,
    "photoUrl" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PropertyNearbyPlace_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PropertyNearbyPlace_propertyId_isActive_sortOrder_idx" ON "PropertyNearbyPlace"("propertyId", "isActive", "sortOrder");

-- CreateIndex
CREATE INDEX "PropertyNearbyPlace_propertyId_category_idx" ON "PropertyNearbyPlace"("propertyId", "category");

-- AddForeignKey
ALTER TABLE "PropertyNearbyPlace" ADD CONSTRAINT "PropertyNearbyPlace_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE CASCADE ON UPDATE CASCADE;
