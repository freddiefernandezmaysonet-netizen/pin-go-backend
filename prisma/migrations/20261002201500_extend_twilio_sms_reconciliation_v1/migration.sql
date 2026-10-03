-- Retry-attempt delivery truth and bounded receipt reconciliation state.
-- Additive only; no production data backfill and no provider/network operation.
ALTER TABLE "TwilioSmsRecovery"
  ADD COLUMN "retryDeliveryStatus" TEXT,
  ADD COLUMN "retryErrorCode" TEXT,
  ADD COLUMN "retryStatusUpdatedAt" TIMESTAMP(3),
  ADD COLUMN "retryDeliveredAt" TIMESTAMP(3);

ALTER TABLE "TwilioSmsRecovery"
  ADD CONSTRAINT "TwilioSmsRecovery_retry_delivery_status_check"
    CHECK ("retryDeliveryStatus" IS NULL OR "retryDeliveryStatus" IN
      ('ACCEPTED','QUEUED','SENDING','SENT','DELIVERED','READ','UNDELIVERED','FAILED','CANCELED')),
  ADD CONSTRAINT "TwilioSmsRecovery_retry_delivery_scope_check"
    CHECK ("retryDeliveryStatus" IS NULL OR ("retryProviderMessageId" IS NOT NULL AND "retriesUsed"=1)),
  ADD CONSTRAINT "TwilioSmsRecovery_retry_error_check"
    CHECK ("retryErrorCode" IS NULL OR "retryErrorCode" ~ '^[0-9]{1,10}$'),
  ADD CONSTRAINT "TwilioSmsRecovery_retry_delivered_check"
    CHECK ("retryDeliveredAt" IS NULL OR "retryDeliveryStatus" IN ('DELIVERED','READ'));

ALTER TABLE "TwilioSmsDeliveryReceipt"
  ADD COLUMN "reconcileAttempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "lastReconciledAt" TIMESTAMP(3),
  ADD COLUMN "nextReconcileAt" TIMESTAMP(3);

ALTER TABLE "TwilioSmsDeliveryReceipt"
  ADD CONSTRAINT "TwilioSmsDeliveryReceipt_reconcile_attempts_check"
    CHECK ("reconcileAttempts" >= 0);

CREATE INDEX "TwilioSmsDeliveryReceipt_disposition_nextReconcileAt_receivedAt_idx"
  ON "TwilioSmsDeliveryReceipt"("disposition","nextReconcileAt","receivedAt");
