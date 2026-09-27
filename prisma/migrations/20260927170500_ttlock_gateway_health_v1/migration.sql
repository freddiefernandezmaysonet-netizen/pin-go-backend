-- CreateTable
CREATE TABLE "TTLockGateway" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "ttlockGatewayId" INTEGER NOT NULL,
    "gatewayMac" TEXT,
    "gatewayName" TEXT,
    "isOnline" BOOLEAN,
    "lastEventAt" TIMESTAMP(3),
    "lastSeenOnlineAt" TIMESTAMP(3),
    "lastSeenOfflineAt" TIMESTAMP(3),
    "source" TEXT,
    "rawPayload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TTLockGateway_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "Lock"
ADD COLUMN "ttlockGatewayRecordId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "TTLockGateway_organizationId_ttlockGatewayId_key"
ON "TTLockGateway"("organizationId", "ttlockGatewayId");

-- CreateIndex
CREATE INDEX "TTLockGateway_ttlockGatewayId_idx"
ON "TTLockGateway"("ttlockGatewayId");

-- CreateIndex
CREATE INDEX "TTLockGateway_organizationId_isOnline_idx"
ON "TTLockGateway"("organizationId", "isOnline");

-- CreateIndex
CREATE INDEX "TTLockGateway_lastEventAt_idx"
ON "TTLockGateway"("lastEventAt");

-- CreateIndex
CREATE INDEX "Lock_ttlockGatewayRecordId_idx"
ON "Lock"("ttlockGatewayRecordId");

-- AddForeignKey
ALTER TABLE "TTLockGateway"
ADD CONSTRAINT "TTLockGateway_organizationId_fkey"
FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lock"
ADD CONSTRAINT "Lock_ttlockGatewayRecordId_fkey"
FOREIGN KEY ("ttlockGatewayRecordId") REFERENCES "TTLockGateway"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
