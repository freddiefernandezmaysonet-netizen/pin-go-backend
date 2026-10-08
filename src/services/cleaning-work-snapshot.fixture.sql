-- Isolated CI only: minimal canonical base, never a Pin&Go production database.
CREATE TYPE "ReservationStatus" AS ENUM ('ACTIVE', 'CANCELLED');
CREATE TABLE "Property" (
  "id" TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL, "status" TEXT NOT NULL,
  "cleaningNfcEnabled" BOOLEAN NOT NULL, "cleaningStartOffsetMinutes" INTEGER NOT NULL
);
CREATE TABLE "Reservation" (
  "id" TEXT PRIMARY KEY, "propertyId" TEXT NOT NULL REFERENCES "Property"("id"),
  "status" "ReservationStatus" NOT NULL, "checkOut" TIMESTAMP(3) NOT NULL
);
CREATE TABLE "StaffMember" (
  "id" TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL, "isActive" BOOLEAN NOT NULL
);
CREATE TABLE "PropertyStaff" (
  "id" TEXT PRIMARY KEY, "propertyId" TEXT NOT NULL REFERENCES "Property"("id"),
  "staffMemberId" TEXT NOT NULL REFERENCES "StaffMember"("id"), "isActive" BOOLEAN NOT NULL,
  UNIQUE ("propertyId", "staffMemberId")
);
CREATE TABLE "CleaningConfirmation" (
  "id" TEXT PRIMARY KEY, "propertyId" TEXT NOT NULL, "reservationId" TEXT NOT NULL,
  "staffMemberId" TEXT NOT NULL, "status" TEXT NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
