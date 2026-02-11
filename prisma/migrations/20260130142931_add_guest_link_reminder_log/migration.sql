-- CreateTable
CREATE TABLE "GuestLinkReminderLog" (
    "id" TEXT NOT NULL,
    "reservationId" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GuestLinkReminderLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GuestLinkReminderLog_reservationId_key" ON "GuestLinkReminderLog"("reservationId");

-- CreateIndex
CREATE INDEX "GuestLinkReminderLog_sentAt_idx" ON "GuestLinkReminderLog"("sentAt");
