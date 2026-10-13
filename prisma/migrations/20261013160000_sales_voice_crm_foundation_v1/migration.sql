-- Add an independent commercial CRM foundation for AI sales calls.
-- Additive only: no existing tables, records, signup, or guest features are altered.
CREATE TABLE "SalesProspect" (
  "id" TEXT NOT NULL,
  "fullName" VARCHAR(200),
  "email" VARCHAR(320),
  "phoneE164" VARCHAR(20),
  "organizationName" VARCHAR(200),
  "propertyCount" INTEGER,
  "preferredLanguage" VARCHAR(8),
  "source" VARCHAR(32) NOT NULL DEFAULT 'PHONE',
  "status" VARCHAR(32) NOT NULL DEFAULT 'NEW',
  "contactConsentAt" TIMESTAMP(3),
  "marketingConsentAt" TIMESTAMP(3),
  "marketingConsentSource" VARCHAR(64),
  "convertedOrganizationId" TEXT,
  "convertedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SalesProspect_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SalesVoiceCall" (
  "id" TEXT NOT NULL,
  "prospectId" TEXT,
  "provider" VARCHAR(32) NOT NULL DEFAULT 'TWILIO',
  "providerCallId" VARCHAR(128),
  "direction" VARCHAR(16) NOT NULL DEFAULT 'INBOUND',
  "fromPhoneE164" VARCHAR(20),
  "toPhoneE164" VARCHAR(20),
  "language" VARCHAR(8),
  "status" VARCHAR(32) NOT NULL DEFAULT 'RECEIVED',
  "disposition" VARCHAR(64),
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "answeredAt" TIMESTAMP(3),
  "endedAt" TIMESTAMP(3),
  "durationSeconds" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SalesVoiceCall_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SalesProspect_status_createdAt_idx" ON "SalesProspect"("status", "createdAt");
CREATE INDEX "SalesProspect_email_idx" ON "SalesProspect"("email");
CREATE INDEX "SalesProspect_phoneE164_idx" ON "SalesProspect"("phoneE164");
CREATE INDEX "SalesProspect_convertedOrganizationId_idx" ON "SalesProspect"("convertedOrganizationId");
CREATE UNIQUE INDEX "SalesVoiceCall_providerCallId_key" ON "SalesVoiceCall"("providerCallId");
CREATE INDEX "SalesVoiceCall_prospectId_startedAt_idx" ON "SalesVoiceCall"("prospectId", "startedAt");
CREATE INDEX "SalesVoiceCall_status_startedAt_idx" ON "SalesVoiceCall"("status", "startedAt");

ALTER TABLE "SalesProspect"
  ADD CONSTRAINT "SalesProspect_convertedOrganizationId_fkey"
  FOREIGN KEY ("convertedOrganizationId") REFERENCES "Organization"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "SalesVoiceCall"
  ADD CONSTRAINT "SalesVoiceCall_prospectId_fkey"
  FOREIGN KEY ("prospectId") REFERENCES "SalesProspect"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
