ALTER TABLE "PinAIReservationFee"
  ALTER COLUMN "billingStatus" SET DEFAULT 'PENDING_CONNECT',
  ADD COLUMN "stripeConnectedAccountId" TEXT,
  ADD COLUMN "stripeDebitPaymentId" TEXT,
  ADD COLUMN "debitStartedAt" TIMESTAMP(3),
  ADD COLUMN "debitGeneration" INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX "PinAIReservationFee_stripeDebitPaymentId_key"
  ON "PinAIReservationFee"("stripeDebitPaymentId");
-- Old SaaS acceptance does not authorize Connect debit. Preserve its evidence.
UPDATE "PinAIReservationFee" SET "billingStatus" = 'NEEDS_REVIEW',
  "lastError" = 'LEGACY_SAAS_FEE_NOT_CONNECT_AUTHORIZED'
  WHERE "termsVersion" <> 'pin-ai-connect-usd-1-reservation-v1';
