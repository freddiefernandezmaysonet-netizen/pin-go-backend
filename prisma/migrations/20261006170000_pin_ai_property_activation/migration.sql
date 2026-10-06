-- No customer is opted in by this migration. Revision zero preserves the
-- existing pilot until a platform administrator explicitly manages the org.
ALTER TABLE "Organization"
  ADD COLUMN "pinAIEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "pinAIRevision" INTEGER NOT NULL DEFAULT 0,
  ADD CONSTRAINT "Organization_pinAIRevision_nonnegative" CHECK ("pinAIRevision" >= 0);
ALTER TABLE "Property"
  ADD COLUMN "pinAIEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "pinAIRevision" INTEGER NOT NULL DEFAULT 0,
  ADD CONSTRAINT "Property_pinAIRevision_nonnegative" CHECK ("pinAIRevision" >= 0);
