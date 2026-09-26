-- Message Delivery Outcomes V1
-- Keep MessageLog.status as the existing send-attempt state and persist provider
-- delivery lifecycle separately so dedupe/retry semantics remain backward compatible.

ALTER TABLE "MessageLog"
  ADD COLUMN "providerDeliveryStatus" TEXT,
  ADD COLUMN "providerStatusUpdatedAt" TIMESTAMP(3),
  ADD COLUMN "providerErrorCode" TEXT,
  ADD COLUMN "providerErrorMessage" TEXT,
  ADD COLUMN "deliveredAt" TIMESTAMP(3);

CREATE INDEX "MessageLog_provider_providerMessageId_idx"
  ON "MessageLog"("provider", "providerMessageId");

CREATE INDEX "MessageLog_providerDeliveryStatus_providerStatusUpdatedAt_idx"
  ON "MessageLog"("providerDeliveryStatus", "providerStatusUpdatedAt");
