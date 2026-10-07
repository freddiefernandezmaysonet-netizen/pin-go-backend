ALTER TABLE "PinAIReservationFee"
  ADD COLUMN "stripeCustomerId" TEXT,
  ADD COLUMN "stripeSubscriptionId" TEXT,
  ADD COLUMN "stripeInvoiceItemId" TEXT,
  ADD COLUMN "stripeInvoiceId" TEXT,
  ADD COLUMN "exportStartedAt" TIMESTAMP(3),
  ADD COLUMN "exportLeaseToken" TEXT,
  ADD COLUMN "exportLeaseUntil" TIMESTAMP(3),
  ADD COLUMN "exportNextAttemptAt" TIMESTAMP(3),
  ADD COLUMN "exportAttempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "lastError" TEXT,
  ADD COLUMN "paidAt" TIMESTAMP(3);
CREATE UNIQUE INDEX "PinAIReservationFee_stripeInvoiceItemId_key" ON "PinAIReservationFee"("stripeInvoiceItemId");
CREATE INDEX "PinAIReservationFee_billingStatus_exportNextAttemptAt_idx" ON "PinAIReservationFee"("billingStatus", "exportNextAttemptAt");
