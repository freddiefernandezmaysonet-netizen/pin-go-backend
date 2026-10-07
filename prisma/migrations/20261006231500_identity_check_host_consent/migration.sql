ALTER TABLE "PropertyGuestAgreement"
  ADD COLUMN "identityBillingTermsVersion" TEXT,
  ADD COLUMN "identityBillingAmountCents" INTEGER,
  ADD COLUMN "identityBillingAcceptedAt" TIMESTAMP(3),
  ADD COLUMN "identityBillingAcceptedBy" TEXT;
ALTER TABLE "PropertyGuestAgreement" ADD CONSTRAINT "PropertyGuestAgreement_identity_billing_consent_complete"
  CHECK (("identityBillingTermsVersion" IS NULL AND "identityBillingAmountCents" IS NULL AND "identityBillingAcceptedAt" IS NULL AND "identityBillingAcceptedBy" IS NULL)
    OR ("identityBillingTermsVersion" IS NOT NULL AND "identityBillingAmountCents" >= 0 AND "identityBillingAmountCents" IS NOT NULL AND "identityBillingAcceptedAt" IS NOT NULL AND "identityBillingAcceptedBy" IS NOT NULL));
