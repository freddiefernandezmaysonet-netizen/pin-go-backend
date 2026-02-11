/*
  Warnings:

  - You are about to drop the column `sentAt` on the `GuestLinkReminderLog` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[reservationId,kind]` on the table `GuestLinkReminderLog` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[ingestKey]` on the table `Reservation` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `to` to the `GuestLinkReminderLog` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "ReminderKind" AS ENUM ('CHECKIN_LINK');

-- DropIndex
DROP INDEX "GuestLinkReminderLog_reservationId_key";

-- DropIndex
DROP INDEX "GuestLinkReminderLog_sentAt_idx";

-- AlterTable
ALTER TABLE "GuestLinkReminderLog" DROP COLUMN "sentAt",
ADD COLUMN     "channel" TEXT NOT NULL DEFAULT 'sms',
ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "error" TEXT,
ADD COLUMN     "kind" "ReminderKind" NOT NULL DEFAULT 'CHECKIN_LINK',
ADD COLUMN     "provider" TEXT,
ADD COLUMN     "providerMsgId" TEXT,
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'SENT',
ADD COLUMN     "to" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "Reservation" ADD COLUMN     "ingestKey" TEXT,
ADD COLUMN     "source" TEXT;

-- CreateIndex
CREATE INDEX "GuestLinkReminderLog_to_createdAt_idx" ON "GuestLinkReminderLog"("to", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "GuestLinkReminderLog_reservationId_kind_key" ON "GuestLinkReminderLog"("reservationId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "Reservation_ingestKey_key" ON "Reservation"("ingestKey");

-- AddForeignKey
ALTER TABLE "GuestLinkReminderLog" ADD CONSTRAINT "GuestLinkReminderLog_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "Reservation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
