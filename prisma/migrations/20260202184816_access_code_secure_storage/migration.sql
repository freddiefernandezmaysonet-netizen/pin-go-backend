/*
  Warnings:

  - You are about to drop the column `accessCode` on the `AccessCode` table. All the data in the column will be lost.
  - Added the required column `accessCodeHash` to the `AccessCode` table without a default value. This is not possible if the table is not empty.
  - Added the required column `accessCodeMasked` to the `AccessCode` table without a default value. This is not possible if the table is not empty.
  - Added the required column `expiresAt` to the `AccessCode` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "AccessCode" DROP COLUMN "accessCode",
ADD COLUMN     "accessCodeEnc" TEXT,
ADD COLUMN     "accessCodeHash" TEXT NOT NULL,
ADD COLUMN     "accessCodeMasked" TEXT NOT NULL,
ADD COLUMN     "expiresAt" TIMESTAMP(3) NOT NULL;

-- CreateIndex
CREATE INDEX "AccessCode_expiresAt_idx" ON "AccessCode"("expiresAt");

-- CreateIndex
CREATE INDEX "AccessCode_accessCodeHash_idx" ON "AccessCode"("accessCodeHash");
