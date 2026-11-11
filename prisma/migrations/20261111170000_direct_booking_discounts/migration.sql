CREATE TABLE "DirectBookingDiscountConfig" (
 "propertyId" TEXT NOT NULL PRIMARY KEY,
 "config" JSONB NOT NULL,
 "version" INTEGER NOT NULL DEFAULT 1,
 "updatedAt" TIMESTAMP(3) NOT NULL,
 CONSTRAINT "DirectBookingDiscountConfig_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE TABLE "DirectBookingPricingSnapshot" (
 "id" TEXT NOT NULL PRIMARY KEY,
 "propertyId" TEXT NOT NULL,
 "checkIn" TIMESTAMP(3) NOT NULL,
 "checkOut" TIMESTAMP(3) NOT NULL,
 "pricing" JSONB NOT NULL,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "DirectBookingPricingSnapshot_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "DirectBookingPricingSnapshot_propertyId_createdAt_idx" ON "DirectBookingPricingSnapshot"("propertyId", "createdAt");
