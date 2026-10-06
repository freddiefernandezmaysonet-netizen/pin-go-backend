-- Existing properties do not inherit commercial consent.
ALTER TABLE "Property"
  ADD COLUMN "pinAITermsVersion" TEXT,
  ADD COLUMN "pinAITermsAcceptedAt" TIMESTAMP(3),
  ADD COLUMN "pinAITermsAcceptedBy" TEXT;
