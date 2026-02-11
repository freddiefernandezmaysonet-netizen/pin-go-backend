/*
  Warnings:

  - You are about to drop the column `stripeCheckoutSessionId` on the `Reservation` table. All the data in the column will be lost.
  - You are about to drop the column `stripePaymentIntentId` on the `Reservation` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[guestToken]` on the table `Reservation` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "Reservation" DROP COLUMN "stripeCheckoutSessionId",
DROP COLUMN "stripePaymentIntentId",
ADD COLUMN     "guestToken" TEXT,
ADD COLUMN     "guestTokenExpiresAt" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "Reservation_guestToken_key" ON "Reservation"("guestToken");
