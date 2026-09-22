-- Damage Case V1 persistence only.
-- No Stripe charge, hold, PaymentIntent, or automatic collection is introduced.

CREATE TYPE "DamageCaseStatus" AS ENUM (
  'OPEN',
  'EVIDENCE_PENDING',
  'HOST_REVIEW',
  'GUEST_NOTIFICATION_PENDING',
  'GUEST_NOTIFIED',
  'CHARGE_BLOCKED',
  'CLOSED_NO_CHARGE'
);

CREATE TABLE "DamageCase" (
  "id" TEXT NOT NULL,
  "reservationId" TEXT NOT NULL,
  "status" "DamageCaseStatus" NOT NULL DEFAULT 'OPEN',
  "requestedAmount" DECIMAL(10,2) NOT NULL,
  "approvedAmount" DECIMAL(10,2),
  "currency" TEXT NOT NULL DEFAULT 'usd',
  "description" TEXT NOT NULL,
  "evidence" JSONB,
  "reportedByUserId" TEXT,
  "hostApprovedAt" TIMESTAMP(3),
  "hostApprovedByUserId" TEXT,
  "guestNotifiedAt" TIMESTAMP(3),
  "closedAt" TIMESTAMP(3),
  "closedReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "DamageCase_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DamageCase_reservationId_key"
ON "DamageCase"("reservationId");

CREATE INDEX "DamageCase_status_createdAt_idx"
ON "DamageCase"("status", "createdAt");

ALTER TABLE "DamageCase"
ADD CONSTRAINT "DamageCase_reservationId_fkey"
FOREIGN KEY ("reservationId") REFERENCES "Reservation"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
