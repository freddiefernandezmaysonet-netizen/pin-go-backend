-- Pin&Go Prisma migration-history reconciliation
-- Part 1 of 5. Generated from committed migrations to the current schema.
-- Do not apply to an existing database unless the schema-equivalence preflight has passed.

BEGIN;
-- CreateEnum
CREATE TYPE "AmenityFeeType" AS ENUM ('PER_STAY', 'PER_NIGHT', 'PER_GUEST', 'PER_GUEST_PER_NIGHT');

-- CreateEnum
CREATE TYPE "OperationalWorkflowState" AS ENUM ('ACTION_REQUIRED', 'WAITING', 'AUTO_RESOLVING', 'RESOLVED');

-- CreateEnum
CREATE TYPE "OperationalVisibility" AS ENUM ('HOST', 'SYSTEM', 'DEVELOPER');

-- CreateEnum
CREATE TYPE "OperationalActor" AS ENUM ('HOST', 'PIN_GO', 'PIN_AI', 'GUEST', 'CLEANER', 'STAFF', 'SYSTEM', 'NONE');

-- CreateEnum
CREATE TYPE "OperationalSeverity" AS ENUM ('INFO', 'WARNING', 'CRITICAL');

-- CreateEnum
CREATE TYPE "OperationalAutoResolveStatus" AS ENUM ('AVAILABLE', 'RUNNING', 'SUCCEEDED', 'FAILED', 'NOT_SUPPORTED');

-- CreateEnum
CREATE TYPE "OperationalActionTarget" AS ENUM ('RESERVATION', 'PROPERTY', 'CLEANING', 'ACCESS', 'DISTRIBUTION', 'PAYMENT', 'MESSAGING', 'GUEST', 'STAFF', 'SYSTEM');

-- CreateEnum
CREATE TYPE "OperationalSourceType" AS ENUM ('AUDIT_ENTRY', 'ENGINE_EVENT', 'WORKER', 'MANUAL', 'PIN_AI');

-- CreateEnum
CREATE TYPE "OperationalResolutionType" AS ENUM ('AUTOMATIC', 'MANUAL', 'EXPIRED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "SeasonType" AS ENUM ('PEAK', 'SHOULDER', 'LOW');

-- CreateEnum
CREATE TYPE "AmenityChargeMode" AS ENUM ('INCLUDED', 'REQUIRED', 'OPTIONAL');

-- CreateEnum
CREATE TYPE "BookingType" AS ENUM ('ONBOARDING', 'DEMO');

-- CreateEnum
CREATE TYPE "PendingSignupStatus" AS ENUM ('PENDING', 'CHECKOUT_CREATED', 'COMPLETED', 'EXPIRED', 'CANCELED', 'FAILED');

-- CreateEnum
CREATE TYPE "DashboardUserRole" AS ENUM ('ADMIN', 'MEMBER', 'PLATFORM_ADMIN', 'ORG_ADMIN');

-- CreateEnum
CREATE TYPE "GuestJourneyState" AS ENUM ('RESERVATION_CONFIRMED', 'VERIFICATION_PENDING', 'VERIFICATION_COMPLETED', 'ACCESS_SCHEDULED', 'READY_FOR_ARRIVAL');

-- CreateEnum
CREATE TYPE "ReservationStatus" AS ENUM ('ACTIVE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PropertyStaffRole" AS ENUM ('PRIMARY', 'BACKUP');

-- CreateEnum
CREATE TYPE "StripeConnectStatus" AS ENUM ('NOT_CONNECTED', 'ONBOARDING_REQUIRED', 'PENDING_VERIFICATION', 'READY', 'RESTRICTED');

-- CreateEnum
CREATE TYPE "HostPayoutStatus" AS ENUM ('NOT_APPLICABLE', 'BLOCKED', 'PENDING_CONNECT', 'ROUTED_TO_CONNECT', 'PAID_TO_HOST', 'PARTIALLY_REFUNDED', 'FAILED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "CancellationPolicyType" AS ENUM ('FLEXIBLE', 'MODERATE', 'FIRM', 'STRICT', 'CUSTOM', 'NON_REFUNDABLE');

-- CreateEnum
CREATE TYPE "CancellationRefundBasis" AS ENUM ('TOTAL_AMOUNT', 'NIGHTLY_SUBTOTAL', 'NIGHTLY_PLUS_CLEANING', 'CUSTOM');

-- CreateEnum
CREATE TYPE "CancellationActor" AS ENUM ('HOST', 'GUEST', 'SYSTEM', 'PIN_AI');

-- CreateEnum
CREATE TYPE "GuestAccessMode" AS ENUM ('PASSCODE_ONLY', 'PASSCODE_PLUS_NFC');

-- CreateEnum
CREATE TYPE "GuestAccessReleaseStatus" AS ENUM ('BLOCKED', 'ELIGIBLE', 'RELEASED');

-- CreateEnum
CREATE TYPE "DeviceHealthStatus" AS ENUM ('HEALTHY', 'WARNING', 'OFFLINE', 'LOW_BATTERY', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "OperationalRiskLevel" AS ENUM ('HEALTHY', 'WARNING', 'AT_RISK', 'CRITICAL', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "PmsProvider" AS ENUM ('CLOUDBEDS', 'GUESTY', 'HOSTAWAY', 'LODGIFY', 'GENERIC', 'CHANNEX');

-- CreateEnum
CREATE TYPE "PmsConnectionStatus" AS ENUM ('ACTIVE', 'DISABLED', 'ERROR');

-- CreateEnum
CREATE TYPE "WebhookEventStatus" AS ENUM ('PENDING', 'PROCESSING', 'PROCESSED', 'FAILED', 'DEAD');

-- AlterEnum
ALTER TYPE "NfcAssignmentStatus" ADD VALUE 'PROVISIONING';

-- AlterEnum
ALTER TYPE "PaymentState" ADD VALUE 'PARTIALLY_REFUNDED';

-- AlterEnum
ALTER TYPE "ReminderKind" ADD VALUE 'VERIFICATION_REMINDER';

-- AlterTable
ALTER TABLE "AccessCode" ADD COLUMN     "accessGrantId" TEXT;

-- AlterTable
ALTER TABLE "AccessGrant" ADD COLUMN     "desiredEndsAt" TIMESTAMP(3),
ADD COLUMN     "desiredStartsAt" TIMESTAMP(3),
ADD COLUMN     "lastAppliedAt" TIMESTAMP(3),
ADD COLUMN     "recoveryAttemptCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "recoveryExhaustedAt" TIMESTAMP(3),
ADD COLUMN     "recoveryLastAttemptAt" TIMESTAMP(3),
ADD COLUMN     "recoveryNextAttemptAt" TIMESTAMP(3),
ADD COLUMN     "recoveryOperation" TEXT,
ADD COLUMN     "revokedReason" TEXT;

-- AlterTable
ALTER TABLE "Lock" ADD COLUMN     "displayName" TEXT;

-- AlterTable
ALTER TABLE "MessageLog" ADD COLUMN     "error" TEXT,
ADD COLUMN     "organizationId" TEXT,
ADD COLUMN     "propertyId" TEXT,
ADD COLUMN     "reservationId" TEXT,
ADD COLUMN     "retryCount" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "NfcAssignment" ADD COLUMN     "provisionedAt" TIMESTAMP(3),
ADD COLUMN     "provisioningStartedAt" TIMESTAMP(3),
ADD COLUMN     "retryCount" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "publicBookingEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "slug" TEXT,
ADD COLUMN     "stripeConnectAccountId" TEXT,
ADD COLUMN     "stripeConnectChargesEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "stripeConnectDetailsSubmitted" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "stripeConnectDisabledReason" TEXT,
ADD COLUMN     "stripeConnectLastSyncedAt" TIMESTAMP(3),
ADD COLUMN     "stripeConnectPayoutsEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "stripeConnectRequirements" JSONB,
ADD COLUMN     "stripeConnectStatus" "StripeConnectStatus" NOT NULL DEFAULT 'NOT_CONNECTED',
ADD COLUMN     "stripeCustomerId" TEXT;

-- AlterTable
ALTER TABLE "Property" ADD COLUMN     "autonomousPricingEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "baseNightlyRate" DECIMAL(10,2),
ADD COLUMN     "checkInTime" VARCHAR(5),
ADD COLUMN     "checkOutTime" VARCHAR(5),
ADD COLUMN     "cleaningFee" DECIMAL(10,2),
ADD COLUMN     "cleaningNfcEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "distributionEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "distributionEnabledAt" TIMESTAMP(3),
ADD COLUMN     "distributionLastError" TEXT,
ADD COLUMN     "distributionLastSyncedAt" TIMESTAMP(3),
ADD COLUMN     "distributionStatus" TEXT NOT NULL DEFAULT 'DISABLED',
ADD COLUMN     "dynamicPricingEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "eventPricingEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "guestAccessMode" "GuestAccessMode" NOT NULL DEFAULT 'PASSCODE_ONLY',
ADD COLUMN     "holidayPricingEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "isPublicBookable" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "latitude" DECIMAL(10,7),
ADD COLUMN     "leadTimeLastMinuteDays" INTEGER NOT NULL DEFAULT 3,
ADD COLUMN     "leadTimeLastMinutePercent" DECIMAL(5,2),
ADD COLUMN     "leadTimePricingEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "longitude" DECIMAL(10,7),
ADD COLUMN     "maxGuests" INTEGER,
ADD COLUMN     "maximumNightlyRate" DECIMAL(10,2),
ADD COLUMN     "maximumNights" INTEGER,
ADD COLUMN     "minimumNightlyRate" DECIMAL(10,2),
ADD COLUMN     "minimumNights" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "occupancyHighAdjustmentPercent" DECIMAL(5,2),
ADD COLUMN     "occupancyHighThresholdPercent" DECIMAL(5,2),
ADD COLUMN     "occupancyLookaheadDays" INTEGER NOT NULL DEFAULT 30,
ADD COLUMN     "occupancyLowAdjustmentPercent" DECIMAL(5,2),
ADD COLUMN     "occupancyLowThresholdPercent" DECIMAL(5,2),
ADD COLUMN     "occupancyPricingEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "publicDescription" TEXT,
ADD COLUMN     "publicPhotos" JSONB,
ADD COLUMN     "publicTitle" TEXT,
ADD COLUMN     "seasonalPricingEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "slug" TEXT,
ADD COLUMN     "smartAutomationEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'ACTIVE',
ADD COLUMN     "weekendMarkupPercent" DECIMAL(5,2);

-- AlterTable
ALTER TABLE "Reservation" ADD COLUMN     "cancellationEvaluatedAt" TIMESTAMP(3),
ADD COLUMN     "cancellationEvaluation" JSONB,
ADD COLUMN     "cancellationPolicyId" TEXT,
ADD COLUMN     "cancellationPolicySnapshot" JSONB,
ADD COLUMN     "cancellationReason" TEXT,
ADD COLUMN     "cancellationRefundAmount" DECIMAL(10,2),
ADD COLUMN     "cancellationRefundPercent" DECIMAL(5,2),
ADD COLUMN     "cancellationRequestedAt" TIMESTAMP(3),
ADD COLUMN     "cancellationRequestedBy" "CancellationActor",
ADD COLUMN     "cancelledAt" TIMESTAMP(3),
ADD COLUMN     "cancelledBy" "CancellationActor",
ADD COLUMN     "cancelledByUserId" TEXT,
ADD COLUMN     "currency" TEXT DEFAULT 'usd',
ADD COLUMN     "directBookingProtectionFeeAmount" DECIMAL(10,2),
ADD COLUMN     "externalId" TEXT,
ADD COLUMN     "externalProvider" TEXT,
ADD COLUMN     "externalRaw" JSONB,
ADD COLUMN     "externalUpdatedAt" TIMESTAMP(3),
ADD COLUMN     "guestAccessEligibleAt" TIMESTAMP(3),
ADD COLUMN     "guestAccessModeSnapshot" "GuestAccessMode" NOT NULL DEFAULT 'PASSCODE_ONLY',
ADD COLUMN     "guestAccessReleaseLastError" TEXT,
ADD COLUMN     "guestAccessReleaseStatus" "GuestAccessReleaseStatus" NOT NULL DEFAULT 'BLOCKED',
ADD COLUMN     "guestAccessReleasedAt" TIMESTAMP(3),
ADD COLUMN     "guestAgreementAcceptance" JSONB,
ADD COLUMN     "guestAgreementSignedAt" TIMESTAMP(3),
ADD COLUMN     "guestAgreementSnapshot" JSONB,
ADD COLUMN     "hostPayoutAmount" DECIMAL(10,2),
ADD COLUMN     "hostPayoutFailureReason" TEXT,
ADD COLUMN     "hostPayoutLastSyncedAt" TIMESTAMP(3),
ADD COLUMN     "hostPayoutStatus" "HostPayoutStatus" NOT NULL DEFAULT 'NOT_APPLICABLE',
ADD COLUMN     "identityDeclaredLegalName" TEXT,
ADD COLUMN     "identityNameMatchStatus" TEXT,
ADD COLUMN     "identityVerificationAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "identityVerificationConsentAt" TIMESTAMP(3),
ADD COLUMN     "identityVerificationProvider" TEXT,
ADD COLUMN     "identityVerificationProviderCostAmount" DECIMAL(10,2),
ADD COLUMN     "identityVerifiedLegalName" TEXT,
ADD COLUMN     "lastHardwareSyncAt" TIMESTAMP(3),
ADD COLUMN     "lastIngestError" TEXT,
ADD COLUMN     "lastIngestedAt" TIMESTAMP(3),
ADD COLUMN     "lastReconciledAt" TIMESTAMP(3),
ADD COLUMN     "lastReconciledCheckIn" TIMESTAMP(3),
ADD COLUMN     "lastReconciledCheckOut" TIMESTAMP(3),
ADD COLUMN     "platformFeeAmount" DECIMAL(10,2),
ADD COLUMN     "preferredLanguage" TEXT NOT NULL DEFAULT 'en',
ADD COLUMN     "pricingBreakdown" JSONB,
ADD COLUMN     "reservationNumber" TEXT,
ADD COLUMN     "securePreCheckinDisclosureAcceptance" JSONB,
ADD COLUMN     "selectedAmenityIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "status" "ReservationStatus" NOT NULL DEFAULT 'ACTIVE',
ADD COLUMN     "stripeApplicationFeeId" TEXT,
ADD COLUMN     "stripeChargeId" TEXT,
ADD COLUMN     "stripeCheckoutSessionId" TEXT,
ADD COLUMN     "stripeConnectedAccountId" TEXT,
ADD COLUMN     "stripeIdentityVerificationLastError" TEXT,
ADD COLUMN     "stripeIdentityVerificationLastEventAt" TIMESTAMP(3),
ADD COLUMN     "stripeIdentityVerificationLastEventId" TEXT,
ADD COLUMN     "stripeIdentityVerificationSessionId" TEXT,
ADD COLUMN     "stripeIdentityVerificationStatus" TEXT,
ADD COLUMN     "stripePaymentIntentId" TEXT,
ADD COLUMN     "stripeTransferId" TEXT,
ADD COLUMN     "totalAmount" DECIMAL(10,2),
ADD COLUMN     "verificationAcceptedRulesAt" TIMESTAMP(3),
ADD COLUMN     "verificationCompletedByIp" TEXT,
ADD COLUMN     "verificationGuestCount" INTEGER,
ADD COLUMN     "verificationStatus" TEXT NOT NULL DEFAULT 'PENDING',
ADD COLUMN     "verificationUserAgent" TEXT,
ADD COLUMN     "verifiedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Subscription" ADD COLUMN     "entitledSmartProperties" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "stripeSmartSubscriptionItemId" TEXT;
COMMIT;
