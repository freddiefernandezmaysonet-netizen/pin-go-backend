CREATE TABLE "CleaningRecoveryPolicy" (
  "propertyId" TEXT NOT NULL PRIMARY KEY,
  "revision" INTEGER NOT NULL DEFAULT 1 CHECK ("revision" > 0),
  "maxDelayMinutes" INTEGER NOT NULL DEFAULT 30 CHECK ("maxDelayMinutes" BETWEEN 0 AND 240),
  "maxAccessExtensionMinutes" INTEGER NOT NULL DEFAULT 0 CHECK ("maxAccessExtensionMinutes" BETWEEN 0 AND 240),
  "arrivalSafetyMarginMinutes" INTEGER NOT NULL DEFAULT 0 CHECK ("arrivalSafetyMarginMinutes" BETWEEN 0 AND 120),
  "updatedByUserId" TEXT NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CleaningRecoveryPolicy_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
