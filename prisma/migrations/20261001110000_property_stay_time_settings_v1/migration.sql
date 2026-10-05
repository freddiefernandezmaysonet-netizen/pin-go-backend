ALTER TABLE "Property"
  ADD COLUMN "stayTimeSettings" JSONB,
  ADD COLUMN "stayTimeSettingsRevision" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "Property"
  ADD CONSTRAINT "Property_stayTimeSettingsRevision_nonnegative"
  CHECK ("stayTimeSettingsRevision" >= 0);
