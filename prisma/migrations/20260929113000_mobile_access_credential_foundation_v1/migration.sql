CREATE TYPE "MobileAccessCredentialStatus" AS ENUM ('PENDING', 'ACTIVE', 'REVOKED', 'EXPIRED', 'FAILED');

CREATE TABLE "MobileAccessCredential" (
  "id" TEXT NOT NULL,
  "guestPersonId" TEXT NOT NULL,
  "guestDeviceSessionId" TEXT NOT NULL,
  "reservationId" TEXT NOT NULL,
  "accessGrantId" TEXT NOT NULL,
  "lockId" TEXT NOT NULL,
  "provider" TEXT NOT NULL DEFAULT 'TTLOCK',
  "providerKeyId" TEXT,
  "lockDataCiphertext" TEXT,
  "lockDataKeyVersion" TEXT,
  "lockMac" TEXT,
  "startsAt" TIMESTAMP(3) NOT NULL,
  "endsAt" TIMESTAMP(3) NOT NULL,
  "status" "MobileAccessCredentialStatus" NOT NULL DEFAULT 'PENDING',
  "issuedAt" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3),
  "lastDeliveredAt" TIMESTAMP(3),
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MobileAccessCredential_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MobileAccessCredential_providerKeyId_key" ON "MobileAccessCredential"("providerKeyId");
CREATE UNIQUE INDEX "MobileAccessCredential_guestDeviceSessionId_accessGrantId_key" ON "MobileAccessCredential"("guestDeviceSessionId", "accessGrantId");
CREATE INDEX "MobileAccessCredential_reservationId_status_idx" ON "MobileAccessCredential"("reservationId", "status");
CREATE INDEX "MobileAccessCredential_accessGrantId_status_idx" ON "MobileAccessCredential"("accessGrantId", "status");
CREATE INDEX "MobileAccessCredential_lockId_status_idx" ON "MobileAccessCredential"("lockId", "status");
CREATE INDEX "MobileAccessCredential_endsAt_status_idx" ON "MobileAccessCredential"("endsAt", "status");

ALTER TABLE "MobileAccessCredential" ADD CONSTRAINT "MobileAccessCredential_guestPersonId_fkey" FOREIGN KEY ("guestPersonId") REFERENCES "GuestPerson"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MobileAccessCredential" ADD CONSTRAINT "MobileAccessCredential_guestDeviceSessionId_fkey" FOREIGN KEY ("guestDeviceSessionId") REFERENCES "GuestDeviceSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MobileAccessCredential" ADD CONSTRAINT "MobileAccessCredential_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "Reservation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MobileAccessCredential" ADD CONSTRAINT "MobileAccessCredential_accessGrantId_fkey" FOREIGN KEY ("accessGrantId") REFERENCES "AccessGrant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MobileAccessCredential" ADD CONSTRAINT "MobileAccessCredential_lockId_fkey" FOREIGN KEY ("lockId") REFERENCES "Lock"("id") ON DELETE CASCADE ON UPDATE CASCADE;
