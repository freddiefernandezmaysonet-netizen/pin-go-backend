-- Property Protection V1 guest response persistence only.
-- No PaymentIntent, charge, hold, capture, refund, or automatic collection is introduced.

CREATE TYPE "DamageCaseGuestResponse" AS ENUM (
  'PENDING',
  'ACKNOWLEDGED',
  'ACCEPTED',
  'DISPUTED'
);

ALTER TABLE "DamageCase"
  ADD COLUMN "guestResponse" "DamageCaseGuestResponse" NOT NULL DEFAULT 'PENDING',
  ADD COLUMN "guestRespondedAt" TIMESTAMP(3),
  ADD COLUMN "guestResponseNote" TEXT,
  ADD COLUMN "guestResponseVersion" TEXT;
