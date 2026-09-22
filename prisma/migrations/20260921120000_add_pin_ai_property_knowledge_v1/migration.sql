-- CreateEnum
CREATE TYPE "PropertyKnowledgeCategory" AS ENUM (
  'PROPERTY',
  'ARRIVAL',
  'ACCESS',
  'WIFI',
  'PARKING',
  'AMENITIES',
  'HOUSE_RULES',
  'APPLIANCE',
  'TROUBLESHOOTING',
  'EMERGENCY',
  'LOCAL_GUIDE'
);

-- CreateEnum
CREATE TYPE "PropertyKnowledgeVisibility" AS ENUM (
  'PUBLIC',
  'CONFIRMED_GUEST',
  'DURING_STAY'
);

-- CreateTable
CREATE TABLE "PropertyKnowledgeEntry" (
  "id" TEXT NOT NULL,
  "propertyId" TEXT NOT NULL,
  "category" "PropertyKnowledgeCategory" NOT NULL,
  "key" VARCHAR(80) NOT NULL,
  "titleEn" VARCHAR(160),
  "titleEs" VARCHAR(160),
  "contentEn" TEXT,
  "contentEs" TEXT,
  "visibility" "PropertyKnowledgeVisibility" NOT NULL DEFAULT 'CONFIRMED_GUEST',
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdByUserId" TEXT,
  "updatedByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "PropertyKnowledgeEntry_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PropertyKnowledgeEntry_content_check" CHECK (
    LENGTH(TRIM(COALESCE("contentEn", ''))) > 0 OR
    LENGTH(TRIM(COALESCE("contentEs", ''))) > 0
  ),
  CONSTRAINT "PropertyKnowledgeEntry_sortOrder_check" CHECK (
    "sortOrder" >= 0 AND "sortOrder" <= 10000
  ),
  CONSTRAINT "PropertyKnowledgeEntry_revision_check" CHECK ("revision" >= 1),
  CONSTRAINT "PropertyKnowledgeEntry_wifi_visibility_check" CHECK (
    "category" <> 'WIFI' OR "visibility" <> 'PUBLIC'
  )
);

-- CreateIndex
CREATE UNIQUE INDEX "PropertyKnowledgeEntry_propertyId_key_key"
ON "PropertyKnowledgeEntry"("propertyId", "key");

-- CreateIndex
CREATE INDEX "PropertyKnowledgeEntry_propertyId_isActive_sortOrder_idx"
ON "PropertyKnowledgeEntry"("propertyId", "isActive", "sortOrder");

-- CreateIndex
CREATE INDEX "PropertyKnowledgeEntry_propertyId_visibility_isActive_idx"
ON "PropertyKnowledgeEntry"("propertyId", "visibility", "isActive");

-- AddForeignKey
ALTER TABLE "PropertyKnowledgeEntry"
ADD CONSTRAINT "PropertyKnowledgeEntry_propertyId_fkey"
FOREIGN KEY ("propertyId") REFERENCES "Property"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
