CREATE TABLE "ChannexHostMessageSend" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "propertyId" TEXT NOT NULL,
  "threadId" TEXT NOT NULL,
  "requestedBy" TEXT NOT NULL,
  "requestKey" VARCHAR(120) NOT NULL,
  "fingerprint" VARCHAR(64) NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "response" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ChannexHostMessageSend_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ChannexHostMessageSend_status_check" CHECK ("status" IN ('PENDING', 'SENT', 'UNKNOWN'))
);
CREATE UNIQUE INDEX "ChannexHostMessageSend_organizationId_requestKey_key"
  ON "ChannexHostMessageSend"("organizationId", "requestKey");
CREATE INDEX "ChannexHostMessageSend_propertyId_threadId_createdAt_idx"
  ON "ChannexHostMessageSend"("propertyId", "threadId", "createdAt");
