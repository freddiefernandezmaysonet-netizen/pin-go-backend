-- Guest Mobile Identity Foundation V1
CREATE TABLE "GuestPerson" (
  "id" TEXT NOT NULL,
  "primaryEmail" TEXT,
  "primaryPhone" TEXT,
  "displayName" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "GuestPerson_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "GuestStayLink" (
  "id" TEXT NOT NULL,
  "guestPersonId" TEXT NOT NULL,
  "reservationId" TEXT NOT NULL,
  "linkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revokedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "GuestStayLink_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "GuestDeviceSession" (
  "id" TEXT NOT NULL,
  "guestPersonId" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "deviceLabel" TEXT,
  "platform" TEXT,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revokedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "GuestDeviceSession_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "GuestStayLink_reservationId_key" ON "GuestStayLink"("reservationId");
CREATE UNIQUE INDEX "GuestDeviceSession_tokenHash_key" ON "GuestDeviceSession"("tokenHash");
CREATE INDEX "GuestPerson_primaryEmail_idx" ON "GuestPerson"("primaryEmail");
CREATE INDEX "GuestPerson_primaryPhone_idx" ON "GuestPerson"("primaryPhone");
CREATE INDEX "GuestStayLink_guestPersonId_revokedAt_idx" ON "GuestStayLink"("guestPersonId", "revokedAt");
CREATE INDEX "GuestDeviceSession_guestPersonId_revokedAt_idx" ON "GuestDeviceSession"("guestPersonId", "revokedAt");
CREATE INDEX "GuestDeviceSession_expiresAt_idx" ON "GuestDeviceSession"("expiresAt");

ALTER TABLE "GuestStayLink" ADD CONSTRAINT "GuestStayLink_guestPersonId_fkey" FOREIGN KEY ("guestPersonId") REFERENCES "GuestPerson"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GuestStayLink" ADD CONSTRAINT "GuestStayLink_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "Reservation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GuestDeviceSession" ADD CONSTRAINT "GuestDeviceSession_guestPersonId_fkey" FOREIGN KEY ("guestPersonId") REFERENCES "GuestPerson"("id") ON DELETE CASCADE ON UPDATE CASCADE;
