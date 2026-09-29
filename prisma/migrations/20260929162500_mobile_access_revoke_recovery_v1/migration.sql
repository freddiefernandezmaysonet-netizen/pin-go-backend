ALTER TABLE "MobileAccessCredential"
ADD COLUMN "recoveryAttemptCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "recoveryLastAttemptAt" TIMESTAMP(3),
ADD COLUMN "recoveryNextAttemptAt" TIMESTAMP(3),
ADD COLUMN "recoveryExhaustedAt" TIMESTAMP(3);

CREATE INDEX "MobileAccessCredential_status_recoveryNextAttemptAt_recoveryExhaustedAt_idx"
ON "MobileAccessCredential"("status", "recoveryNextAttemptAt", "recoveryExhaustedAt");
