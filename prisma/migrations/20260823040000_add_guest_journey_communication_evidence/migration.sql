ALTER TABLE "MessageLog"
ADD COLUMN "communicationType" TEXT;

CREATE INDEX "MessageLog_reservationId_communicationType_channel_status_createdAt_idx"
ON "MessageLog"("reservationId", "communicationType", "channel", "status", "createdAt");
