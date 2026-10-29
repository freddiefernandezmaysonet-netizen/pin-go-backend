-- AlterTable
ALTER TABLE "GuestDeviceSession" ADD COLUMN     "guestAppActivationId" TEXT;

-- CreateTable
CREATE TABLE "GuestAppActivationChallenge" (
    "id" TEXT NOT NULL,
    "reservationId" TEXT NOT NULL,
    "guestTokenHash" TEXT NOT NULL,
    "browserHash" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "deliveredAt" TIMESTAMP(3),
    "verifiedAt" TIMESTAMP(3),
    "activationTokenHash" TEXT,
    "activationExpiresAt" TIMESTAMP(3),
    "consumedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "GuestAppActivationChallenge_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GuestAppActivationChallenge_activationTokenHash_key" ON "GuestAppActivationChallenge"("activationTokenHash");

-- CreateIndex
CREATE INDEX "GuestAppActivationChallenge_reservationId_createdAt_idx" ON "GuestAppActivationChallenge"("reservationId", "createdAt");

-- CreateIndex
CREATE INDEX "GuestAppActivationChallenge_expiresAt_idx" ON "GuestAppActivationChallenge"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "GuestDeviceSession_guestAppActivationId_key" ON "GuestDeviceSession"("guestAppActivationId");

-- AddForeignKey
ALTER TABLE "GuestDeviceSession" ADD CONSTRAINT "GuestDeviceSession_guestAppActivationId_fkey" FOREIGN KEY ("guestAppActivationId") REFERENCES "GuestAppActivationChallenge"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GuestAppActivationChallenge" ADD CONSTRAINT "GuestAppActivationChallenge_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "Reservation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
