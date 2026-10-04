CREATE TABLE "ChannexAIThread" (
  "id" TEXT NOT NULL PRIMARY KEY, "organizationId" TEXT NOT NULL, "propertyId" TEXT NOT NULL,
  "threadId" TEXT NOT NULL, "mode" TEXT NOT NULL DEFAULT 'AUTO', "reason" TEXT,
  "since" TIMESTAMP(3) NOT NULL, "leaseToken" TEXT, "leaseUntil" TIMESTAMP(3),
  "sending" BOOLEAN NOT NULL DEFAULT false, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ChannexAIThread_mode_check" CHECK ("mode" IN ('AUTO', 'HUMAN'))
);
CREATE UNIQUE INDEX "ChannexAIThread_organizationId_propertyId_threadId_key" ON "ChannexAIThread"("organizationId", "propertyId", "threadId");
CREATE TABLE "ChannexAIInbound" (
  "id" TEXT NOT NULL PRIMARY KEY, "organizationId" TEXT NOT NULL, "propertyId" TEXT NOT NULL,
  "threadId" TEXT NOT NULL, "messageId" TEXT NOT NULL, "status" TEXT NOT NULL DEFAULT 'QUEUED',
  "reason" TEXT, "leaseToken" TEXT, "leaseUntil" TIMESTAMP(3),
  "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ChannexAIInbound_status_check" CHECK ("status" IN ('QUEUED','PROCESSING','SENDING','SENT','SKIPPED','NEEDS_HOST','UNKNOWN'))
);
CREATE UNIQUE INDEX "ChannexAIInbound_organizationId_propertyId_threadId_messageId_key" ON "ChannexAIInbound"("organizationId", "propertyId", "threadId", "messageId");
CREATE INDEX "ChannexAIInbound_status_receivedAt_idx" ON "ChannexAIInbound"("status", "receivedAt");
