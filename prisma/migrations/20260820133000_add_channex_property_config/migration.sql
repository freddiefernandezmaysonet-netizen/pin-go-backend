CREATE TABLE "ChannexPropertyConfig" (
  "id" TEXT NOT NULL,
  "propertyId" TEXT NOT NULL,
  "propertyType" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ChannexPropertyConfig_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ChannexPropertyConfig_propertyId_key"
ON "ChannexPropertyConfig"("propertyId");

CREATE INDEX "ChannexPropertyConfig_propertyType_idx"
ON "ChannexPropertyConfig"("propertyType");

ALTER TABLE "ChannexPropertyConfig"
ADD CONSTRAINT "ChannexPropertyConfig_propertyId_fkey"
FOREIGN KEY ("propertyId") REFERENCES "Property"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
