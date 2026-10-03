-- Additive evidence journal only. No reservation/contact/access mutation.
CREATE TABLE "TwilioSmsRecovery" (
  "messageLogId" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "propertyId" TEXT NOT NULL,
  "reservationId" TEXT NOT NULL,
  "originalProviderMessageId" TEXT NOT NULL,
  "originalDeliveryStatus" TEXT NOT NULL,
  "originalErrorCode" TEXT NOT NULL,
  "firstFailureAt" TIMESTAMP(3) NOT NULL,
  "retryNotBefore" TIMESTAMP(3) NOT NULL,
  "minimumSpacingMs" INTEGER NOT NULL,
  "sourceFingerprint" TEXT NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'AVAILABLE',
  "retriesUsed" INTEGER NOT NULL DEFAULT 0,
  "claimToken" TEXT,
  "claimedAt" TIMESTAMP(3),
  "validUntil" TIMESTAMP(3),
  "retryProviderMessageId" TEXT,
  "nextMessageKey" TEXT,
  "nextMessageAt" TIMESTAMP(3),
  "lastDecision" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TwilioSmsRecovery_pkey" PRIMARY KEY ("messageLogId"),
  CONSTRAINT "TwilioSmsRecovery_scope_check" CHECK (
    "messageLogId" ~ '^[A-Za-z0-9_-]{1,160}$' AND
    "organizationId" ~ '^[A-Za-z0-9_-]{1,160}$' AND
    "propertyId" ~ '^[A-Za-z0-9_-]{1,160}$' AND
    "reservationId" ~ '^[A-Za-z0-9_-]{1,160}$'),
  CONSTRAINT "TwilioSmsRecovery_failure_check" CHECK (
    "originalProviderMessageId" ~ '^SM[0-9a-fA-F]{32}$' AND
    "originalDeliveryStatus" IN ('UNDELIVERED','FAILED') AND "originalErrorCode"='30005'),
  CONSTRAINT "TwilioSmsRecovery_window_check" CHECK (
    "retryNotBefore">"firstFailureAt" AND "minimumSpacingMs" BETWEEN 60000 AND 3600000),
  CONSTRAINT "TwilioSmsRecovery_fingerprint_check" CHECK ("sourceFingerprint" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "TwilioSmsRecovery_budget_check" CHECK ("retriesUsed" IN (0,1)),
  CONSTRAINT "TwilioSmsRecovery_state_check" CHECK (
    "state" IN ('AVAILABLE','CLAIMED','OUTCOME_UNKNOWN','SUBMITTED','YIELDED','DELIVERED','EXPIRED','REVIEW')),
  CONSTRAINT "TwilioSmsRecovery_claim_check" CHECK (
    ("retriesUsed"=0 AND "claimToken" IS NULL AND "claimedAt" IS NULL AND "retryProviderMessageId" IS NULL
      AND "state" NOT IN ('CLAIMED','OUTCOME_UNKNOWN','SUBMITTED')) OR
    ("retriesUsed"=1 AND "claimToken" IS NOT NULL AND "claimedAt" IS NOT NULL
      AND "validUntil" IS NOT NULL AND "validUntil">"claimedAt"
      AND "state" NOT IN ('AVAILABLE','YIELDED'))),
  CONSTRAINT "TwilioSmsRecovery_submission_check" CHECK (
    ("retryProviderMessageId" IS NULL OR
      ("retryProviderMessageId" ~ '^SM[0-9a-fA-F]{32}$' AND
       "retryProviderMessageId" <> "originalProviderMessageId" AND "retriesUsed"=1))
    AND ("state"<>'SUBMITTED' OR "retryProviderMessageId" IS NOT NULL))
);
CREATE UNIQUE INDEX "TwilioSmsRecovery_originalProviderMessageId_key" ON "TwilioSmsRecovery"("originalProviderMessageId");
CREATE UNIQUE INDEX "TwilioSmsRecovery_claimToken_key" ON "TwilioSmsRecovery"("claimToken");
CREATE UNIQUE INDEX "TwilioSmsRecovery_retryProviderMessageId_key" ON "TwilioSmsRecovery"("retryProviderMessageId");
CREATE INDEX "TwilioSmsRecovery_state_retryNotBefore_idx" ON "TwilioSmsRecovery"("state","retryNotBefore");
CREATE INDEX "TwilioSmsRecovery_organizationId_propertyId_reservationId_idx"
  ON "TwilioSmsRecovery"("organizationId","propertyId","reservationId");
