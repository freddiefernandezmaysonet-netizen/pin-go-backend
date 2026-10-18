CREATE TABLE "HostMobileNotificationRead" (
  "organizationId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "propertyId" TEXT NOT NULL,
  "eventId" TEXT NOT NULL,
  "readAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "HostMobileNotificationRead_scope_key" PRIMARY KEY ("organizationId", "userId", "propertyId", "eventId")
);
CREATE INDEX "HostMobileNotificationRead_readAt_idx" ON "HostMobileNotificationRead"("readAt");
CREATE INDEX "HostMobilePushDelivery_inbox_idx" ON "HostMobilePushDelivery"("organizationId", "userId", "occurredAt" DESC);
