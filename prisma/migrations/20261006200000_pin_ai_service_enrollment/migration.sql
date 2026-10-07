CREATE TABLE "PinAIServiceEnrollment" (
  "reservationId" TEXT PRIMARY KEY REFERENCES "Reservation"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "organizationId" TEXT NOT NULL,
  "propertyId" TEXT NOT NULL,
  "stripeConnectedAccountId" TEXT NOT NULL,
  "termsVersion" TEXT NOT NULL,
  "acceptedBy" TEXT NOT NULL,
  "acceptedAt" TIMESTAMP(3) NOT NULL,
  "enrolledAt" TIMESTAMP(3) NOT NULL,
  "checkIn" TIMESTAMP(3) NOT NULL,
  "checkOut" TIMESTAMP(3) NOT NULL,
  "opensAt" TIMESTAMP(3) NOT NULL,
  "closesAt" TIMESTAMP(3) NOT NULL,
  "propertyRevision" INTEGER NOT NULL,
  "organizationRevision" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'SCHEDULED',
  "reason" TEXT,
  "resolvedAt" TIMESTAMP(3),
  CHECK ("checkOut" > "checkIn" AND "opensAt" < "closesAt" AND "enrolledAt" < "opensAt"),
  CHECK ("acceptedAt" <= "enrolledAt" AND "propertyRevision" > 0 AND "organizationRevision" > 0)
);
CREATE INDEX "PinAIServiceEnrollment_organizationId_status_opensAt_idx"
  ON "PinAIServiceEnrollment"("organizationId", "status", "opensAt");
-- No backfill: historical eligibility cannot be inferred from today's settings.
