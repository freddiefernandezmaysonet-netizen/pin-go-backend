/*
  Warnings:

  - A unique constraint covering the columns `[reservationId,staffMemberId]` on the table `StaffAssignment` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[organizationId]` on the table `Subscription` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `organizationId` to the `Subscription` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE "Subscription" DROP CONSTRAINT "Subscription_personId_fkey";

-- AlterTable
ALTER TABLE "Subscription" ADD COLUMN     "graceUntil" TIMESTAMP(3),
ADD COLUMN     "organizationId" TEXT NOT NULL,
ADD COLUMN     "stripeCustomerId" TEXT,
ALTER COLUMN "personId" DROP NOT NULL,
ALTER COLUMN "stripeSubscriptionId" DROP NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "StaffAssignment_reservationId_staffMemberId_key" ON "StaffAssignment"("reservationId", "staffMemberId");

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_organizationId_key" ON "Subscription"("organizationId");

-- CreateIndex
CREATE INDEX "Subscription_organizationId_status_idx" ON "Subscription"("organizationId", "status");

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE SET NULL ON UPDATE CASCADE;
