-- Additive capture only. Does not enable webhooks, replay, or message sending.
CREATE TABLE "MessageDeliveryReceipt" (
  "id" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "accountKey" TEXT NOT NULL,
  "eventKey" TEXT NOT NULL,
  "fingerprint" TEXT NOT NULL,
  "providerMessageId" TEXT NOT NULL,
  "deliveryStatus" TEXT NOT NULL,
  "eventAt" TIMESTAMP(3) NOT NULL,
  "deliveredAt" TIMESTAMP(3),
  "providerErrorCode" TEXT,
  "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MessageDeliveryReceipt_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "MessageDeliveryReceipt_provider_accountKey_eventKey_key"
  ON "MessageDeliveryReceipt"("provider", "accountKey", "eventKey");
CREATE INDEX "MessageDeliveryReceipt_provider_accountKey_providerMessageId_idx"
  ON "MessageDeliveryReceipt"("provider", "accountKey", "providerMessageId");
CREATE INDEX "MessageDeliveryReceipt_receivedAt_idx" ON "MessageDeliveryReceipt"("receivedAt");
