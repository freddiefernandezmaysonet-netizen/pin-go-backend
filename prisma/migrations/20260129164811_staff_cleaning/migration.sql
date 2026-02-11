-- CreateEnum
CREATE TYPE "AccessGrantType" AS ENUM ('GUEST', 'STAFF');

-- CreateEnum
CREATE TYPE "StaffAccessMethod" AS ENUM ('NFC_TIMEBOUND', 'EKEY_TIMEBOUND');

-- CreateEnum
CREATE TYPE "StaffAssignmentStatus" AS ENUM ('SCHEDULED', 'ACTIVE', 'COMPLETED', 'CANCELLED', 'FAILED');

-- AlterTable
ALTER TABLE "AccessGrant" ADD COLUMN     "staffMemberId" TEXT,
ADD COLUMN     "ttlockRefId" VARCHAR(128),
ADD COLUMN     "type" "AccessGrantType" NOT NULL DEFAULT 'GUEST';

-- AlterTable
ALTER TABLE "Property" ADD COLUMN     "cleaningDurationMinutes" INTEGER NOT NULL DEFAULT 180,
ADD COLUMN     "cleaningStartOffsetMinutes" INTEGER NOT NULL DEFAULT 30;

-- CreateTable
CREATE TABLE "StaffMember" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "phoneE164" TEXT,
    "photoUrl" TEXT,
    "companyName" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "ttlockCardRef" VARCHAR(128),
    "ttlockUserRef" VARCHAR(128),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StaffMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StaffAssignment" (
    "id" TEXT NOT NULL,
    "reservationId" TEXT NOT NULL,
    "staffMemberId" TEXT NOT NULL,
    "method" "StaffAccessMethod" NOT NULL DEFAULT 'NFC_TIMEBOUND',
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "status" "StaffAssignmentStatus" NOT NULL DEFAULT 'SCHEDULED',
    "lastError" TEXT,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "accessGrantId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StaffAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StaffMember_organizationId_isActive_idx" ON "StaffMember"("organizationId", "isActive");

-- CreateIndex
CREATE INDEX "StaffMember_phoneE164_idx" ON "StaffMember"("phoneE164");

-- CreateIndex
CREATE UNIQUE INDEX "StaffAssignment_accessGrantId_key" ON "StaffAssignment"("accessGrantId");

-- CreateIndex
CREATE INDEX "StaffAssignment_reservationId_idx" ON "StaffAssignment"("reservationId");

-- CreateIndex
CREATE INDEX "StaffAssignment_staffMemberId_idx" ON "StaffAssignment"("staffMemberId");

-- CreateIndex
CREATE INDEX "StaffAssignment_status_startsAt_endsAt_idx" ON "StaffAssignment"("status", "startsAt", "endsAt");

-- CreateIndex
CREATE INDEX "AccessGrant_type_staffMemberId_idx" ON "AccessGrant"("type", "staffMemberId");

-- CreateIndex
CREATE INDEX "Lock_propertyId_isActive_idx" ON "Lock"("propertyId", "isActive");

-- CreateIndex
CREATE INDEX "Person_organizationId_role_idx" ON "Person"("organizationId", "role");

-- CreateIndex
CREATE INDEX "Property_organizationId_idx" ON "Property"("organizationId");

-- AddForeignKey
ALTER TABLE "AccessGrant" ADD CONSTRAINT "AccessGrant_staffMemberId_fkey" FOREIGN KEY ("staffMemberId") REFERENCES "StaffMember"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffMember" ADD CONSTRAINT "StaffMember_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffAssignment" ADD CONSTRAINT "StaffAssignment_accessGrantId_fkey" FOREIGN KEY ("accessGrantId") REFERENCES "AccessGrant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffAssignment" ADD CONSTRAINT "StaffAssignment_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "Reservation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffAssignment" ADD CONSTRAINT "StaffAssignment_staffMemberId_fkey" FOREIGN KEY ("staffMemberId") REFERENCES "StaffMember"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
