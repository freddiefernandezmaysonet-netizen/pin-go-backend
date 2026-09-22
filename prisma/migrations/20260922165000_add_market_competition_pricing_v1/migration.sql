-- CreateEnum
CREATE TYPE "MarketPricingStrategy" AS ENUM ('OCCUPANCY', 'BALANCED', 'REVENUE');

-- CreateEnum
CREATE TYPE "MarketPricingPosition" AS ENUM ('VALUE', 'COMPETITIVE', 'PREMIUM');

-- CreateEnum
CREATE TYPE "MarketPricingAggressiveness" AS ENUM ('CONSERVATIVE', 'MODERATE', 'AGGRESSIVE');

-- CreateEnum
CREATE TYPE "MarketComparableStatus" AS ENUM ('ACTIVE', 'EXCLUDED', 'STALE');

-- CreateEnum
CREATE TYPE "MarketPricingRunStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'PARTIAL', 'FAILED');

-- CreateTable
CREATE TABLE "MarketPricingProfile" (
    "id" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "provider" TEXT,
    "currency" VARCHAR(3) NOT NULL,
    "strategy" "MarketPricingStrategy" NOT NULL DEFAULT 'BALANCED',
    "position" "MarketPricingPosition" NOT NULL DEFAULT 'COMPETITIVE',
    "aggressiveness" "MarketPricingAggressiveness" NOT NULL DEFAULT 'MODERATE',
    "minimumConfidence" DECIMAL(5,2) NOT NULL DEFAULT 70,
    "maximumIncreasePercent" DECIMAL(5,2) NOT NULL DEFAULT 20,
    "maximumDecreasePercent" DECIMAL(5,2) NOT NULL DEFAULT 15,
    "marketRadiusKm" DECIMAL(8,2),
    "maximumComparables" INTEGER NOT NULL DEFAULT 10,
    "refreshIntervalHours" INTEGER NOT NULL DEFAULT 24,
    "lastSuccessfulRefreshAt" TIMESTAMP(3),
    "nextRefreshAt" TIMESTAMP(3),
    "lastErrorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketPricingProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketComparable" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "externalListingId" TEXT NOT NULL,
    "listingName" TEXT,
    "latitude" DECIMAL(10,7),
    "longitude" DECIMAL(10,7),
    "distanceKm" DECIMAL(8,2),
    "similarityScore" DECIMAL(5,2) NOT NULL,
    "status" "MarketComparableStatus" NOT NULL DEFAULT 'ACTIVE',
    "attributes" JSONB,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketComparable_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketPricingRun" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "status" "MarketPricingRunStatus" NOT NULL DEFAULT 'PENDING',
    "requestedDateFrom" DATE NOT NULL,
    "requestedDateTo" DATE NOT NULL,
    "comparableCount" INTEGER NOT NULL DEFAULT 0,
    "snapshotCount" INTEGER NOT NULL DEFAULT 0,
    "changedDateKeys" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "errorCode" TEXT,
    "errorSummary" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketPricingRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketPricingSnapshot" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "stayDate" DATE NOT NULL,
    "sampleSize" INTEGER NOT NULL,
    "availableCount" INTEGER NOT NULL,
    "lowerRate" DECIMAL(10,2),
    "medianRate" DECIMAL(10,2) NOT NULL,
    "upperRate" DECIMAL(10,2),
    "targetRate" DECIMAL(10,2) NOT NULL,
    "confidence" DECIMAL(5,2) NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "evidence" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MarketPricingSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MarketPricingProfile_propertyId_key" ON "MarketPricingProfile"("propertyId");

-- CreateIndex
CREATE INDEX "MarketPricingProfile_enabled_nextRefreshAt_idx" ON "MarketPricingProfile"("enabled", "nextRefreshAt");

-- CreateIndex
CREATE INDEX "MarketPricingProfile_provider_idx" ON "MarketPricingProfile"("provider");

-- CreateIndex
CREATE INDEX "MarketComparable_profileId_status_similarityScore_idx" ON "MarketComparable"("profileId", "status", "similarityScore");

-- CreateIndex
CREATE UNIQUE INDEX "MarketComparable_profileId_provider_externalListingId_key" ON "MarketComparable"("profileId", "provider", "externalListingId");

-- CreateIndex
CREATE INDEX "MarketPricingRun_profileId_status_createdAt_idx" ON "MarketPricingRun"("profileId", "status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "MarketPricingRun_profileId_active_key" ON "MarketPricingRun"("profileId") WHERE "status" IN ('PENDING', 'RUNNING');

-- CreateIndex
CREATE INDEX "MarketPricingRun_status_createdAt_idx" ON "MarketPricingRun"("status", "createdAt");

-- CreateIndex
CREATE INDEX "MarketPricingSnapshot_profileId_stayDate_expiresAt_idx" ON "MarketPricingSnapshot"("profileId", "stayDate", "expiresAt");

-- CreateIndex
CREATE INDEX "MarketPricingSnapshot_runId_idx" ON "MarketPricingSnapshot"("runId");

-- CreateIndex
CREATE UNIQUE INDEX "MarketPricingSnapshot_profileId_provider_stayDate_observedA_key" ON "MarketPricingSnapshot"("profileId", "provider", "stayDate", "observedAt");

-- AddForeignKey
ALTER TABLE "MarketPricingProfile" ADD CONSTRAINT "MarketPricingProfile_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketComparable" ADD CONSTRAINT "MarketComparable_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "MarketPricingProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketPricingRun" ADD CONSTRAINT "MarketPricingRun_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "MarketPricingProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketPricingSnapshot" ADD CONSTRAINT "MarketPricingSnapshot_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "MarketPricingProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketPricingSnapshot" ADD CONSTRAINT "MarketPricingSnapshot_runId_fkey" FOREIGN KEY ("runId") REFERENCES "MarketPricingRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

