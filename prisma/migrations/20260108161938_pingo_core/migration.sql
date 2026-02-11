/*
  Warnings:

  - You are about to drop the column `name` on the `Lock` table. All the data in the column will be lost.
  - Added the required column `propertyId` to the `Lock` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "public"."PersonRole" AS ENUM ('MANAGER', 'GUEST', 'STAFF');

-- CreateEnum
CREATE TYPE "public"."SubscriptionStatus" AS ENUM ('ACTIVE', 'PAST_DUE', 'CANCELED', 'TRIALING', 'UNPAID', 'INCOMPLETE', 'INCOMPLETE_EXPIRED');

-- CreateEnum
CREATE TYPE "public"."AccessMethod" AS ENUM ('PASSCODE_TIMEBOUND', 'AUTHORIZED_ADMIN');

-- CreateEnum
CREATE TYPE "public"."AccessStatus" AS ENUM ('PENDING', 'ACTIVE', 'SUSPENDED', 'REVOKED', 'FAILED');

-- CreateEnum
CREATE TYPE "public"."PaymentState" AS ENUM ('NONE', 'PAID', 'REFUNDED');

-- AlterTable
ALTER TABLE "public"."Lock" DROP COLUMN "name",
ADD COLUMN     "isActive" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "locationLabel" TEXT,
ADD COLUMN     "propertyId" TEXT NOT NULL,
ADD COLUMN     "ttlockLockName" TEXT;

-- CreateTable
CREATE TABLE "public"."Property" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "address1" TEXT,
    "city" TEXT,
    "region" TEXT,
    "country" TEXT,
    "timezone" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Property_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Person" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "role" "public"."PersonRole" NOT NULL,
    "fullName" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "stripeCustomerId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Person_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Subscription" (
    "id" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "stripeSubscriptionId" TEXT NOT NULL,
    "status" "public"."SubscriptionStatus" NOT NULL,
    "currentPeriodStart" TIMESTAMP(3),
    "currentPeriodEnd" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Reservation" (
    "id" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "guestName" TEXT NOT NULL,
    "guestEmail" TEXT,
    "guestPhone" TEXT,
    "roomName" TEXT,
    "checkIn" TIMESTAMP(3) NOT NULL,
    "checkOut" TIMESTAMP(3) NOT NULL,
    "paymentState" "public"."PaymentState" NOT NULL DEFAULT 'NONE',
    "stripeCheckoutSessionId" TEXT,
    "stripePaymentIntentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Reservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."AccessGrant" (
    "id" TEXT NOT NULL,
    "lockId" TEXT NOT NULL,
    "personId" TEXT,
    "reservationId" TEXT,
    "method" "public"."AccessMethod" NOT NULL,
    "status" "public"."AccessStatus" NOT NULL DEFAULT 'PENDING',
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "unlockKey" TEXT DEFAULT '#',
    "accessCodeMasked" TEXT,
    "ttlockKeyboardPwdId" INTEGER,
    "ttlockKeyId" INTEGER,
    "ttlockPayload" JSONB,
    "linkedStripeEventId" TEXT,
    "linkedStripeCustomerId" TEXT,
    "linkedStripeSubscriptionId" TEXT,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccessGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."StripeEventLog" (
    "id" TEXT NOT NULL,
    "stripeId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "livemode" BOOLEAN,
    "payload" JSONB NOT NULL,
    "processedAt" TIMESTAMP(3),
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StripeEventLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."TTLockAuth" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "uid" INTEGER,
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TTLockAuth_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."LockGroup" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LockGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."LockGroupLock" (
    "id" TEXT NOT NULL,
    "lockGroupId" TEXT NOT NULL,
    "lockId" TEXT NOT NULL,

    CONSTRAINT "LockGroupLock_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ManagerAssignment" (
    "id" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "lockGroupId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ManagerAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Person_stripeCustomerId_key" ON "public"."Person"("stripeCustomerId");

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_stripeSubscriptionId_key" ON "public"."Subscription"("stripeSubscriptionId");

-- CreateIndex
CREATE INDEX "Subscription_personId_status_idx" ON "public"."Subscription"("personId", "status");

-- CreateIndex
CREATE INDEX "Reservation_propertyId_checkIn_checkOut_idx" ON "public"."Reservation"("propertyId", "checkIn", "checkOut");

-- CreateIndex
CREATE INDEX "AccessGrant_lockId_status_startsAt_endsAt_idx" ON "public"."AccessGrant"("lockId", "status", "startsAt", "endsAt");

-- CreateIndex
CREATE INDEX "AccessGrant_personId_status_idx" ON "public"."AccessGrant"("personId", "status");

-- CreateIndex
CREATE INDEX "AccessGrant_reservationId_status_idx" ON "public"."AccessGrant"("reservationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "StripeEventLog_stripeId_key" ON "public"."StripeEventLog"("stripeId");

-- CreateIndex
CREATE INDEX "StripeEventLog_type_processedAt_idx" ON "public"."StripeEventLog"("type", "processedAt");

-- CreateIndex
CREATE UNIQUE INDEX "TTLockAuth_organizationId_key" ON "public"."TTLockAuth"("organizationId");

-- CreateIndex
CREATE INDEX "LockGroup_organizationId_idx" ON "public"."LockGroup"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "LockGroupLock_lockGroupId_lockId_key" ON "public"."LockGroupLock"("lockGroupId", "lockId");

-- CreateIndex
CREATE UNIQUE INDEX "ManagerAssignment_personId_lockGroupId_key" ON "public"."ManagerAssignment"("personId", "lockGroupId");

-- AddForeignKey
ALTER TABLE "public"."Property" ADD CONSTRAINT "Property_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "public"."Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Lock" ADD CONSTRAINT "Lock_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "public"."Property"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Person" ADD CONSTRAINT "Person_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "public"."Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Subscription" ADD CONSTRAINT "Subscription_personId_fkey" FOREIGN KEY ("personId") REFERENCES "public"."Person"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Reservation" ADD CONSTRAINT "Reservation_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "public"."Property"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."AccessGrant" ADD CONSTRAINT "AccessGrant_lockId_fkey" FOREIGN KEY ("lockId") REFERENCES "public"."Lock"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."AccessGrant" ADD CONSTRAINT "AccessGrant_personId_fkey" FOREIGN KEY ("personId") REFERENCES "public"."Person"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."AccessGrant" ADD CONSTRAINT "AccessGrant_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "public"."Reservation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."TTLockAuth" ADD CONSTRAINT "TTLockAuth_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "public"."Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."LockGroup" ADD CONSTRAINT "LockGroup_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "public"."Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."LockGroupLock" ADD CONSTRAINT "LockGroupLock_lockGroupId_fkey" FOREIGN KEY ("lockGroupId") REFERENCES "public"."LockGroup"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."LockGroupLock" ADD CONSTRAINT "LockGroupLock_lockId_fkey" FOREIGN KEY ("lockId") REFERENCES "public"."Lock"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ManagerAssignment" ADD CONSTRAINT "ManagerAssignment_personId_fkey" FOREIGN KEY ("personId") REFERENCES "public"."Person"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ManagerAssignment" ADD CONSTRAINT "ManagerAssignment_lockGroupId_fkey" FOREIGN KEY ("lockGroupId") REFERENCES "public"."LockGroup"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
