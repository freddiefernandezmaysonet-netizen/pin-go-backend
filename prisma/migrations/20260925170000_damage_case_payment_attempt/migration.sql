-- Property Protection V1 financial execution ledger.
-- Additive only; no existing Damage Case is backfilled or charged.
ALTER TYPE "DamageCaseStatus" ADD VALUE IF NOT EXISTS 'CHARGED';

CREATE TYPE "DamageCasePaymentAttemptStatus" AS ENUM (
    'PREPARED',
    'PROCESSING',
    'REQUIRES_ACTION',
    'SUCCEEDED',
    'FAILED',
    'CANCELED'
);

CREATE TABLE "DamageCasePaymentAttempt" (
    "id" TEXT NOT NULL,
    "damageCaseId" TEXT NOT NULL,
    "paymentAuthorizationId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "reservationId" TEXT NOT NULL,
    "connectedAccountId" TEXT NOT NULL,
    "claimRevision" TEXT NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "status" "DamageCasePaymentAttemptStatus" NOT NULL DEFAULT 'PREPARED',
    "stripePaymentIntentId" TEXT,
    "stripeChargeId" TEXT,
    "providerStatus" TEXT,
    "failureCode" TEXT,
    "declineCode" TEXT,
    "failureMessage" TEXT,
    "executionLeaseId" TEXT,
    "executionLeaseExpiresAt" TIMESTAMP(3),
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "requestedByUserId" TEXT NOT NULL,
    "firstAttemptedAt" TIMESTAMP(3),
    "lastAttemptedAt" TIMESTAMP(3),
    "succeededAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "DamageCasePaymentAttempt_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "DamageCasePaymentAttempt_positive_amount" CHECK ("amountMinor" > 0),
    CONSTRAINT "DamageCasePaymentAttempt_currency" CHECK ("currency" = 'usd'),
    CONSTRAINT "DamageCasePaymentAttempt_attempt_count" CHECK ("attemptCount" >= 0)
);

CREATE UNIQUE INDEX "DamageCasePaymentAttempt_damageCaseId_key" ON "DamageCasePaymentAttempt"("damageCaseId");
CREATE UNIQUE INDEX "DamageCasePaymentAttempt_paymentAuthorizationId_key" ON "DamageCasePaymentAttempt"("paymentAuthorizationId");
CREATE UNIQUE INDEX "DamageCasePaymentAttempt_idempotencyKey_key" ON "DamageCasePaymentAttempt"("idempotencyKey");
CREATE UNIQUE INDEX "DamageCasePaymentAttempt_stripePaymentIntentId_key" ON "DamageCasePaymentAttempt"("stripePaymentIntentId");
CREATE INDEX "DamageCasePaymentAttempt_organizationId_status_createdAt_idx" ON "DamageCasePaymentAttempt"("organizationId", "status", "createdAt");
CREATE INDEX "DamageCasePaymentAttempt_reservationId_idx" ON "DamageCasePaymentAttempt"("reservationId");

ALTER TABLE "DamageCasePaymentAttempt" ADD CONSTRAINT "DamageCasePaymentAttempt_damageCaseId_fkey"
FOREIGN KEY ("damageCaseId") REFERENCES "DamageCase"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "DamageCasePaymentAttempt" ADD CONSTRAINT "DamageCasePaymentAttempt_paymentAuthorizationId_fkey"
FOREIGN KEY ("paymentAuthorizationId") REFERENCES "DamageCasePaymentAuthorization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
