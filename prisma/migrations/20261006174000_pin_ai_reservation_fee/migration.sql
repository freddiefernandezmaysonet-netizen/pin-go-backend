CREATE TABLE "PinAIReservationFee" (
  "reservationId" TEXT PRIMARY KEY REFERENCES "Reservation"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "organizationId" TEXT NOT NULL REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "propertyId" TEXT NOT NULL REFERENCES "Property"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "amountCents" INTEGER NOT NULL DEFAULT 100 CHECK ("amountCents" = 100),
  "currency" TEXT NOT NULL DEFAULT 'USD' CHECK ("currency" = 'USD'),
  "termsVersion" TEXT NOT NULL,
  "acceptedBy" TEXT NOT NULL,
  "acceptedAt" TIMESTAMP(3) NOT NULL,
  "serviceStartedAt" TIMESTAMP(3) NOT NULL,
  "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "billingStatus" TEXT NOT NULL DEFAULT 'PENDING_INVOICE'
);
CREATE INDEX "PinAIReservationFee_organizationId_billingStatus_recordedAt_idx"
  ON "PinAIReservationFee"("organizationId", "billingStatus", "recordedAt");
