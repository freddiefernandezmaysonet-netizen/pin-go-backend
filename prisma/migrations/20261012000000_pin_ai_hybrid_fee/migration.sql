ALTER TABLE "PinAIReservationFee"
ADD COLUMN "collectionMethod" TEXT,
ADD COLUMN "stripePaymentIntentId" TEXT,
ADD COLUMN "stripeApplicationFeeId" TEXT,
ADD COLUMN "stripeReversalId" TEXT,
ADD COLUMN "reversedAt" TIMESTAMP(3),
ADD COLUMN "reversalStartedAt" TIMESTAMP(3),
ADD COLUMN "reversalRequest" JSONB;
CREATE UNIQUE INDEX "PinAIReservationFee_stripeReversalId_key" ON "PinAIReservationFee"("stripeReversalId");
