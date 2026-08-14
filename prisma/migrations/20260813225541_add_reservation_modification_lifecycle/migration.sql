-- Pin&Go Direct Booking — Guest Reservation Modification V1
-- Durable modification lifecycle, independent Stripe references and canonical financial totals.

BEGIN;

-- CreateEnum
CREATE TYPE "ReservationModificationStatus" AS ENUM (
    'AWAITING_PAYMENT',
    'PAYMENT_PROCESSING',
    'PAYMENT_FAILED',
    'HOST_APPROVAL_REQUIRED',
    'APPLYING',
    'APPLIED',
    'EXPIRED',
    'CANCELLED'
);

-- CreateEnum
CREATE TYPE "ReservationModificationFinancialAction" AS ENUM (
    'ADDITIONAL_PAYMENT_REQUIRED',
    'NO_PAYMENT_REQUIRED',
    'NO_REFUND_DUE_CONFIRMATION_REQUIRED',
    'REDUCTION_REVIEW_REQUIRED'
);

-- Add canonical guest counts and financial totals as nullable for safe backfill.
ALTER TABLE "Reservation"
ADD COLUMN "adults" INTEGER,
ADD COLUMN "amountCollected" DECIMAL(10,2),
ADD COLUMN "amountRefunded" DECIMAL(10,2),
ADD COLUMN "children" INTEGER;

-- Preserve existing Direct Booking guest counts when metadata is available.
UPDATE "Reservation"
SET
    "adults" = CASE
        WHEN COALESCE("externalRaw"->'metadata'->>'adults', '') ~ '^[0-9]{1,3}$'
             AND ("externalRaw"->'metadata'->>'adults')::INTEGER >= 1
        THEN ("externalRaw"->'metadata'->>'adults')::INTEGER
        ELSE GREATEST(1, COALESCE("verificationGuestCount", 1))
    END,
    "children" = CASE
        WHEN COALESCE("externalRaw"->'metadata'->>'children', '') ~ '^[0-9]{1,3}$'
        THEN ("externalRaw"->'metadata'->>'children')::INTEGER
        ELSE 0
    END;

-- Preserve gross collected and refunded amounts for existing paid reservations.
UPDATE "Reservation"
SET
    "amountCollected" = CASE
        WHEN "paymentState" IN ('PAID', 'PARTIALLY_REFUNDED', 'REFUNDED')
        THEN GREATEST(0, COALESCE("totalAmount", 0))
        ELSE 0
    END,
    "amountRefunded" = CASE
        WHEN "cancellationRefundAmount" IS NOT NULL
        THEN GREATEST(0, "cancellationRefundAmount")
        WHEN COALESCE(
            "externalRaw"->'refund'->>'amountDecimal',
            "externalRaw"->'refund'->>'amount',
            ''
        ) ~ '^[0-9]+([.][0-9]{1,2})?$'
        THEN GREATEST(
            0,
            COALESCE(
                "externalRaw"->'refund'->>'amountDecimal',
                "externalRaw"->'refund'->>'amount'
            )::DECIMAL(10,2)
        )
        WHEN "paymentState" = 'REFUNDED'
        THEN GREATEST(0, COALESCE("totalAmount", 0))
        ELSE 0
    END;

ALTER TABLE "Reservation"
ALTER COLUMN "adults" SET DEFAULT 1,
ALTER COLUMN "adults" SET NOT NULL,
ALTER COLUMN "amountCollected" SET DEFAULT 0,
ALTER COLUMN "amountCollected" SET NOT NULL,
ALTER COLUMN "amountRefunded" SET DEFAULT 0,
ALTER COLUMN "amountRefunded" SET NOT NULL,
ALTER COLUMN "children" SET DEFAULT 0,
ALTER COLUMN "children" SET NOT NULL;

-- CreateTable
CREATE TABLE "ReservationModification" (
    "id" TEXT NOT NULL,
    "reservationId" TEXT NOT NULL,
    "clientRequestId" TEXT NOT NULL,
    "requestFingerprint" TEXT NOT NULL,
    "status" "ReservationModificationStatus" NOT NULL,
    "financialAction" "ReservationModificationFinancialAction" NOT NULL,
    "requestedBy" "CancellationActor" NOT NULL DEFAULT 'GUEST',
    "requestSource" TEXT NOT NULL DEFAULT 'GUEST_MANAGE_RESERVATION',
    "baseReservationUpdatedAt" TIMESTAMP(3) NOT NULL,
    "currentCheckIn" TIMESTAMP(3) NOT NULL,
    "currentCheckOut" TIMESTAMP(3) NOT NULL,
    "proposedCheckIn" TIMESTAMP(3) NOT NULL,
    "proposedCheckOut" TIMESTAMP(3) NOT NULL,
    "currentAdults" INTEGER NOT NULL,
    "currentChildren" INTEGER NOT NULL,
    "proposedAdults" INTEGER NOT NULL,
    "proposedChildren" INTEGER NOT NULL,
    "currentSelectedAmenityIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "proposedSelectedAmenityIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "currentPricing" JSONB NOT NULL,
    "proposedPricing" JSONB NOT NULL,
    "reductionPolicy" JSONB,
    "guestConfirmation" JSONB,
    "currentTotalAmount" DECIMAL(10,2) NOT NULL,
    "proposedTotalAmount" DECIMAL(10,2) NOT NULL,
    "amountDifference" DECIMAL(10,2) NOT NULL,
    "additionalChargeAmount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "additionalPlatformFeeAmount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "additionalHostPayoutAmount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'usd',
    "stripeConnectedAccountId" TEXT,
    "stripeCheckoutSessionId" TEXT,
    "stripePaymentIntentId" TEXT,
    "stripeChargeId" TEXT,
    "stripeTransferId" TEXT,
    "stripeApplicationFeeId" TEXT,
    "stripePaymentStatus" TEXT,
    "checkoutExpiresAt" TIMESTAMP(3),
    "failureCode" TEXT,
    "failureMessage" TEXT,
    "failureDetails" JSONB,
    "appliedAt" TIMESTAMP(3),
    "expiredAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReservationModification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ReservationModification_stripeCheckoutSessionId_key"
ON "ReservationModification"("stripeCheckoutSessionId");

-- CreateIndex
CREATE UNIQUE INDEX "ReservationModification_stripePaymentIntentId_key"
ON "ReservationModification"("stripePaymentIntentId");

-- CreateIndex
CREATE UNIQUE INDEX "ReservationModification_stripeChargeId_key"
ON "ReservationModification"("stripeChargeId");

-- CreateIndex
CREATE UNIQUE INDEX "ReservationModification_stripeTransferId_key"
ON "ReservationModification"("stripeTransferId");

-- CreateIndex
CREATE UNIQUE INDEX "ReservationModification_stripeApplicationFeeId_key"
ON "ReservationModification"("stripeApplicationFeeId");

-- CreateIndex
CREATE INDEX "ReservationModification_reservationId_status_idx"
ON "ReservationModification"("reservationId", "status");

-- CreateIndex
CREATE INDEX "ReservationModification_status_checkoutExpiresAt_idx"
ON "ReservationModification"("status", "checkoutExpiresAt");

-- CreateIndex
CREATE INDEX "ReservationModification_proposedCheckIn_proposedCheckOut_st_idx"
ON "ReservationModification"("proposedCheckIn", "proposedCheckOut", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ReservationModification_reservationId_clientRequestId_key"
ON "ReservationModification"("reservationId", "clientRequestId");

-- AddForeignKey
ALTER TABLE "ReservationModification"
ADD CONSTRAINT "ReservationModification_reservationId_fkey"
FOREIGN KEY ("reservationId") REFERENCES "Reservation"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
