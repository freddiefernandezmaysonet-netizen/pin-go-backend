ALTER TABLE "MessageDeliveryReceipt"
  ADD COLUMN "processedAt" TIMESTAMP(3),
  ADD COLUMN "processedMessageLogId" TEXT,
  ADD COLUMN "lastAttemptAt" TIMESTAMP(3),
  ADD COLUMN "lastOutcome" TEXT,
  ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0;
CREATE INDEX "MessageDeliveryReceipt_pending_idx"
  ON "MessageDeliveryReceipt"("processedAt", "lastAttemptAt", "receivedAt");
