-- Property Protection V1 — Card on File persistence only.
-- Default-off. This migration does not alter Checkout or initiate Stripe activity.

ALTER TABLE "Property"
ADD COLUMN "propertyProtectionEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "propertyProtectionMode" TEXT NOT NULL DEFAULT 'CARD_ON_FILE',
ADD COLUMN "maxDamageLiabilityAmount" DECIMAL(10,2);

ALTER TABLE "Reservation"
ADD COLUMN "propertyProtectionRequiredSnapshot" BOOLEAN,
ADD COLUMN "propertyProtectionModeSnapshot" TEXT,
ADD COLUMN "maxDamageLiabilityAmountSnapshot" DECIMAL(10,2),
ADD COLUMN "propertyProtectionPolicySnapshot" JSONB,
ADD COLUMN "damagePaymentConsent" JSONB,
ADD COLUMN "damagePaymentMethodStatus" TEXT NOT NULL DEFAULT 'NOT_REQUIRED',
ADD COLUMN "stripeDamageCustomerId" TEXT,
ADD COLUMN "stripeDamagePaymentMethodId" TEXT;
