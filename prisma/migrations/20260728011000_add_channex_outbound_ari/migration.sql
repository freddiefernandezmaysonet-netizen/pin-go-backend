-- Pin&Go Distribution Engine — Channex Outbound ARI V1
-- Durable outbox, coalesced delivery, attempt evidence and property throttle state.

BEGIN;

-- CreateEnum
CREATE TYPE "ChannexAriMessageKind" AS ENUM ('AVAILABILITY', 'RATES_RESTRICTIONS');

-- CreateEnum
CREATE TYPE "ChannexAriSyncMode" AS ENUM ('INCREMENTAL', 'FULL');

-- CreateEnum
CREATE TYPE "ChannexAriScope" AS ENUM ('EXACT_DATES', 'DATE_RANGE', 'FULL_HORIZON');

-- CreateEnum
CREATE TYPE "DistributionOutboxStatus" AS ENUM ('PENDING', 'CLAIMED', 'MERGED', 'SUPERSEDED', 'DEAD');

-- CreateEnum
CREATE TYPE "ChannexAriDeliveryStatus" AS ENUM ('READY', 'PROCESSING', 'RETRY_WAIT', 'SENT', 'DEAD', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "ChannexAriAttemptOutcome" AS ENUM ('IN_FLIGHT', 'SUCCESS', 'RETRYABLE_FAILURE', 'TERMINAL_FAILURE', 'UNKNOWN_AFTER_LEASE');

-- CreateTable
CREATE TABLE "ChannexAriDelivery" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "messageKind" "ChannexAriMessageKind" NOT NULL,
    "syncMode" "ChannexAriSyncMode" NOT NULL,
    "scope" "ChannexAriScope" NOT NULL,
    "dateFrom" DATE,
    "dateToExclusive" DATE,
    "dateKeys" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" "ChannexAriDeliveryStatus" NOT NULL DEFAULT 'READY',
    "payload" JSONB NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "payloadValueCount" INTEGER NOT NULL,
    "payloadBytes" INTEGER NOT NULL,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "leaseToken" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "channexTaskId" TEXT,
    "httpStatus" INTEGER,
    "warningCount" INTEGER NOT NULL DEFAULT 0,
    "lastErrorCode" TEXT,
    "lastErrorSummary" TEXT,
    "queuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processingStartedAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "deadAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChannexAriDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DistributionOutboxEvent" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "provider" "PmsProvider" NOT NULL DEFAULT 'CHANNEX',
    "messageKind" "ChannexAriMessageKind" NOT NULL,
    "syncMode" "ChannexAriSyncMode" NOT NULL,
    "scope" "ChannexAriScope" NOT NULL,
    "dateFrom" DATE,
    "dateToExclusive" DATE,
    "dateKeys" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "trigger" TEXT NOT NULL,
    "sourceEntityType" TEXT,
    "sourceEntityId" TEXT,
    "correlationId" TEXT,
    "status" "DistributionOutboxStatus" NOT NULL DEFAULT 'PENDING',
    "availableAt" TIMESTAMP(3) NOT NULL,
    "materializationAttemptCount" INTEGER NOT NULL DEFAULT 0,
    "claimedAt" TIMESTAMP(3),
    "claimToken" TEXT,
    "claimExpiresAt" TIMESTAMP(3),
    "lastErrorCode" TEXT,
    "lastErrorSummary" TEXT,
    "deadAt" TIMESTAMP(3),
    "deliveryId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DistributionOutboxEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChannexAriDeliveryAttempt" (
    "id" TEXT NOT NULL,
    "deliveryId" TEXT NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "outcome" "ChannexAriAttemptOutcome" NOT NULL DEFAULT 'IN_FLIGHT',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "httpStatus" INTEGER,
    "channexTaskId" TEXT,
    "warningCount" INTEGER NOT NULL DEFAULT 0,
    "retryAfterMs" INTEGER,
    "errorCode" TEXT,
    "responseMeta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChannexAriDeliveryAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChannexAriPropertyState" (
    "propertyId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "availabilityNextAllowedAt" TIMESTAMP(3),
    "ratesNextAllowedAt" TIMESTAMP(3),
    "pausedUntil" TIMESTAMP(3),
    "lastRateLimitAt" TIMESTAMP(3),
    "lastSuccessfulAvailabilityAt" TIMESTAMP(3),
    "lastSuccessfulRatesAt" TIMESTAMP(3),
    "lastFullSyncRequestedAt" TIMESTAMP(3),
    "lastFullSyncCompletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChannexAriPropertyState_pkey" PRIMARY KEY ("propertyId")
);

-- CreateIndex
CREATE INDEX "ChannexAriDelivery_status_nextAttemptAt_idx" ON "ChannexAriDelivery"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "ChannexAriDelivery_propertyId_messageKind_status_idx" ON "ChannexAriDelivery"("propertyId", "messageKind", "status");

-- CreateIndex
CREATE INDEX "ChannexAriDelivery_leaseExpiresAt_idx" ON "ChannexAriDelivery"("leaseExpiresAt");

-- CreateIndex
CREATE INDEX "ChannexAriDelivery_channexTaskId_idx" ON "ChannexAriDelivery"("channexTaskId");

-- CreateIndex
CREATE INDEX "ChannexAriDelivery_organizationId_propertyId_idx" ON "ChannexAriDelivery"("organizationId", "propertyId");

-- CreateIndex
CREATE INDEX "ChannexAriDelivery_connectionId_listingId_idx" ON "ChannexAriDelivery"("connectionId", "listingId");

-- CreateIndex
CREATE INDEX "DistributionOutboxEvent_status_availableAt_idx" ON "DistributionOutboxEvent"("status", "availableAt");

-- CreateIndex
CREATE INDEX "DistributionOutboxEvent_status_claimExpiresAt_idx" ON "DistributionOutboxEvent"("status", "claimExpiresAt");

-- CreateIndex
CREATE INDEX "DistributionOutboxEvent_propertyId_messageKind_status_idx" ON "DistributionOutboxEvent"("propertyId", "messageKind", "status");

-- CreateIndex
CREATE INDEX "DistributionOutboxEvent_correlationId_idx" ON "DistributionOutboxEvent"("correlationId");

-- CreateIndex
CREATE INDEX "DistributionOutboxEvent_claimToken_idx" ON "DistributionOutboxEvent"("claimToken");

-- CreateIndex
CREATE INDEX "DistributionOutboxEvent_deliveryId_idx" ON "DistributionOutboxEvent"("deliveryId");

-- CreateIndex
CREATE INDEX "DistributionOutboxEvent_organizationId_propertyId_idx" ON "DistributionOutboxEvent"("organizationId", "propertyId");

-- CreateIndex
CREATE UNIQUE INDEX "ChannexAriDeliveryAttempt_deliveryId_attemptNumber_key" ON "ChannexAriDeliveryAttempt"("deliveryId", "attemptNumber");

-- CreateIndex
CREATE INDEX "ChannexAriDeliveryAttempt_deliveryId_startedAt_idx" ON "ChannexAriDeliveryAttempt"("deliveryId", "startedAt");

-- CreateIndex
CREATE INDEX "ChannexAriDeliveryAttempt_outcome_startedAt_idx" ON "ChannexAriDeliveryAttempt"("outcome", "startedAt");

-- CreateIndex
CREATE INDEX "ChannexAriPropertyState_organizationId_idx" ON "ChannexAriPropertyState"("organizationId");

-- CreateIndex
CREATE INDEX "ChannexAriPropertyState_pausedUntil_idx" ON "ChannexAriPropertyState"("pausedUntil");

-- CreateIndex
CREATE INDEX "ChannexAriPropertyState_availabilityNextAllowedAt_idx" ON "ChannexAriPropertyState"("availabilityNextAllowedAt");

-- CreateIndex
CREATE INDEX "ChannexAriPropertyState_ratesNextAllowedAt_idx" ON "ChannexAriPropertyState"("ratesNextAllowedAt");

-- AddForeignKey
ALTER TABLE "DistributionOutboxEvent" ADD CONSTRAINT "DistributionOutboxEvent_deliveryId_fkey" FOREIGN KEY ("deliveryId") REFERENCES "ChannexAriDelivery"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChannexAriDeliveryAttempt" ADD CONSTRAINT "ChannexAriDeliveryAttempt_deliveryId_fkey" FOREIGN KEY ("deliveryId") REFERENCES "ChannexAriDelivery"("id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
