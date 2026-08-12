-- Pin&Go Prisma migration-history reconciliation
-- Part 2 of 5. First 18 missing tables.
-- Do not apply to an existing database unless the schema-equivalence preflight has passed.

BEGIN;
-- CreateTable
CREATE TABLE "DashboardUser" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "fullName" TEXT,
    "role" "DashboardUserRole" NOT NULL DEFAULT 'ORG_ADMIN',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "tokenVersion" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "DashboardUser_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PasswordResetToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PasswordResetToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PasswordResetSmsCode" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PasswordResetSmsCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PropertyNightlyRate" (
    "id" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "rate" DECIMAL(10,2) NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PropertyNightlyRate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PropertySeason" (
    "id" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "SeasonType" NOT NULL DEFAULT 'SHOULDER',
    "startMonth" INTEGER NOT NULL,
    "startDay" INTEGER NOT NULL,
    "endMonth" INTEGER NOT NULL,
    "endDay" INTEGER NOT NULL,
    "adjustmentPercent" DECIMAL(5,2) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "source" TEXT NOT NULL DEFAULT 'CUSTOM',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PropertySeason_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketSeasonTemplate" (
    "id" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "region" TEXT,
    "name" TEXT NOT NULL,
    "type" "SeasonType" NOT NULL DEFAULT 'SHOULDER',
    "startMonth" INTEGER NOT NULL,
    "startDay" INTEGER NOT NULL,
    "endMonth" INTEGER NOT NULL,
    "endDay" INTEGER NOT NULL,
    "adjustmentPercent" DECIMAL(5,2) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketSeasonTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PropertyHolidayPricing" (
    "id" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "startMonth" INTEGER NOT NULL,
    "startDay" INTEGER NOT NULL,
    "endMonth" INTEGER NOT NULL,
    "endDay" INTEGER NOT NULL,
    "adjustmentPercent" DECIMAL(5,2) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "source" TEXT NOT NULL DEFAULT 'PIN_GO_DEFAULT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PropertyHolidayPricing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PendingSignup" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "fullName" TEXT,
    "organizationName" TEXT NOT NULL,
    "phone" TEXT,
    "requestedLocks" INTEGER NOT NULL DEFAULT 1,
    "stripeCheckoutSessionId" TEXT,
    "stripeCustomerId" TEXT,
    "stripeSubscriptionId" TEXT,
    "stripePriceId" TEXT,
    "status" "PendingSignupStatus" NOT NULL DEFAULT 'PENDING',
    "organizationId" TEXT,
    "completedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PendingSignup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GuestJourney" (
    "id" TEXT NOT NULL,
    "reservationId" TEXT NOT NULL,
    "currentState" "GuestJourneyState" NOT NULL DEFAULT 'RESERVATION_CONFIRMED',
    "stateChangedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "verificationCompletedAt" TIMESTAMP(3),
    "accessScheduledAt" TIMESTAMP(3),
    "readyForArrivalAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GuestJourney_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceHealth" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "propertyId" TEXT,
    "lockId" TEXT NOT NULL,
    "battery" INTEGER,
    "gatewayConnected" BOOLEAN,
    "isOnline" BOOLEAN,
    "lastSyncAt" TIMESTAMP(3),
    "lastEventAt" TIMESTAMP(3),
    "lastSeenAt" TIMESTAMP(3),
    "healthStatus" "DeviceHealthStatus" NOT NULL DEFAULT 'UNKNOWN',
    "healthMessage" TEXT,
    "source" TEXT,
    "rawPayload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "hasActiveAccess" BOOLEAN,
    "nextCheckInAt" TIMESTAMP(3),
    "operationalMessage" TEXT,
    "operationalRisk" "OperationalRiskLevel" NOT NULL DEFAULT 'UNKNOWN',
    "recommendedAction" TEXT,
    "riskCalculatedAt" TIMESTAMP(3),
    "batteryLastCheckedAt" TIMESTAMP(3),
    "batteryNextCheckAt" TIMESTAMP(3),
    "batteryLastSuccessfulAt" TIMESTAMP(3),
    "batteryLastFailedAt" TIMESTAMP(3),
    "batteryLastError" TEXT,
    "batteryRawPayload" JSONB,
    "batteryProviderResponseAt" TIMESTAMP(3),
    "gatewayLastCheckedAt" TIMESTAMP(3),
    "gatewayLastSuccessfulAt" TIMESTAMP(3),
    "gatewayNextCheckAt" TIMESTAMP(3),
    "gatewayDisconnectedSince" TIMESTAMP(3),
    "gatewayCheckReservationId" TEXT,
    "gatewayRssi" INTEGER,
    "gatewayLastFailedAt" TIMESTAMP(3),
    "gatewayLastError" TEXT,
    "gatewayRawPayload" JSONB,
    "gatewayProviderResponseAt" TIMESTAMP(3),
    "gatewayCriticalAlertReservationId" TEXT,
    "gatewayCriticalAlertStatus" TEXT,
    "gatewayCriticalAlertAttemptCount" INTEGER NOT NULL DEFAULT 0,
    "gatewayCriticalAlertLastAttemptAt" TIMESTAMP(3),
    "gatewayCriticalAlertSentAt" TIMESTAMP(3),
    "gatewayCriticalAlertRecipients" JSONB,
    "gatewayCriticalAlertLastError" TEXT,

    CONSTRAINT "DeviceHealth_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MessageDispatchLog" (
    "id" TEXT NOT NULL,
    "reservationId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MessageDispatchLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PropertyStaff" (
    "id" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "staffMemberId" TEXT NOT NULL,
    "role" "PropertyStaffRole" NOT NULL,
    "backupOrder" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PropertyStaff_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CleaningConfirmation" (
    "id" TEXT NOT NULL,
    "reservationId" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "staffMemberId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CleaningConfirmation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PmsConnection" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "provider" "PmsProvider" NOT NULL,
    "status" "PmsConnectionStatus" NOT NULL DEFAULT 'ACTIVE',
    "credentialsEncrypted" TEXT,
    "webhookSecret" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PmsConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PmsListing" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "externalListingId" TEXT NOT NULL,
    "name" TEXT,
    "metadata" JSONB,
    "propertyId" TEXT,
    "lockId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PmsListing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PmsReservationLink" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "externalReservationId" TEXT NOT NULL,
    "reservationId" TEXT NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "canonicalHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PmsReservationLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookEventIngest" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "provider" "PmsProvider" NOT NULL,
    "eventType" TEXT NOT NULL,
    "externalEventId" TEXT,
    "payloadRaw" JSONB NOT NULL,
    "status" "WebhookEventStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WebhookEventIngest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PropertyDevice" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "externalId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PropertyDevice_pkey" PRIMARY KEY ("id")
);
COMMIT;
