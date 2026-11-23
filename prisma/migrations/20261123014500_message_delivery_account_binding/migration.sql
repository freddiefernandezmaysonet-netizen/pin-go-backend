-- No backfill: historical messages have no verified sending-account provenance.
ALTER TABLE "MessageLog" ADD COLUMN "providerAccountKey" TEXT;
CREATE INDEX "MessageLog_provider_account_message_idx"
  ON "MessageLog"("provider", "providerAccountKey", "providerMessageId");
