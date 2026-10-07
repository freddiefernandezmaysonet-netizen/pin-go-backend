-- Durable, allowlisted callback evidence. No phone, SMS body, access code or token.
-- No cascading relations: a receipt can precede MessageLog and survives deletion.
CREATE TABLE "TwilioSmsDeliveryReceipt" (
  "id" TEXT NOT NULL,
  "accountSid" TEXT NOT NULL,
  "providerMessageId" TEXT NOT NULL,
  "deliveryStatus" TEXT NOT NULL,
  "errorCode" TEXT,
  "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "disposition" TEXT NOT NULL DEFAULT 'PENDING',
  "messageLogId" TEXT,
  "processedAt" TIMESTAMP(3),
  CONSTRAINT "TwilioSmsDeliveryReceipt_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "TwilioSmsDeliveryReceipt_accountSid_providerMessageId_idx"
  ON "TwilioSmsDeliveryReceipt"("accountSid", "providerMessageId");
CREATE INDEX "TwilioSmsDeliveryReceipt_disposition_receivedAt_idx"
  ON "TwilioSmsDeliveryReceipt"("disposition", "receivedAt");
