-- CreateEnum
CREATE TYPE "NfcCardStatus" AS ENUM ('AVAILABLE', 'ASSIGNED', 'LOST', 'RETIRED');

-- CreateEnum
CREATE TYPE "NfcAssignmentRole" AS ENUM ('GUEST', 'CLEANING');

-- CreateEnum
CREATE TYPE "NfcAssignmentStatus" AS ENUM ('ACTIVE', 'ENDED', 'FAILED');

-- CreateTable
CREATE TABLE "NfcCard" (
    "id" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "label" TEXT,
    "ttlockCardId" INTEGER NOT NULL,
    "status" "NfcCardStatus" NOT NULL DEFAULT 'AVAILABLE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NfcCard_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NfcAssignment" (
    "id" TEXT NOT NULL,
    "reservationId" TEXT NOT NULL,
    "nfcCardId" TEXT NOT NULL,
    "role" "NfcAssignmentRole" NOT NULL,
    "status" "NfcAssignmentStatus" NOT NULL DEFAULT 'ACTIVE',
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NfcAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "NfcCard_propertyId_status_idx" ON "NfcCard"("propertyId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "NfcCard_propertyId_ttlockCardId_key" ON "NfcCard"("propertyId", "ttlockCardId");

-- CreateIndex
CREATE INDEX "NfcAssignment_reservationId_status_idx" ON "NfcAssignment"("reservationId", "status");

-- CreateIndex
CREATE INDEX "NfcAssignment_nfcCardId_status_idx" ON "NfcAssignment"("nfcCardId", "status");

-- AddForeignKey
ALTER TABLE "NfcAssignment" ADD CONSTRAINT "NfcAssignment_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "Reservation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NfcAssignment" ADD CONSTRAINT "NfcAssignment_nfcCardId_fkey" FOREIGN KEY ("nfcCardId") REFERENCES "NfcCard"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
