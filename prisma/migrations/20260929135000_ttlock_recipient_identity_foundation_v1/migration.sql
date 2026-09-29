CREATE TYPE "TTLockRecipientIdentityStatus" AS ENUM ('PENDING', 'ACTIVE', 'DELETE_PENDING', 'DELETED', 'FAILED');

CREATE TABLE "TTLockRecipientIdentity" (
  "id" TEXT NOT NULL,
  "guestPersonId" TEXT NOT NULL,
  "username" TEXT NOT NULL,
  "passwordCiphertext" TEXT NOT NULL,
  "passwordKeyVersion" TEXT NOT NULL,
  "providerUid" TEXT,
  "accessTokenCiphertext" TEXT,
  "refreshTokenCiphertext" TEXT,
  "tokenKeyVersion" TEXT,
  "tokenExpiresAt" TIMESTAMP(3),
  "status" "TTLockRecipientIdentityStatus" NOT NULL DEFAULT 'PENDING',
  "registeredAt" TIMESTAMP(3),
  "deleteRequestedAt" TIMESTAMP(3),
  "deletedAt" TIMESTAMP(3),
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TTLockRecipientIdentity_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TTLockRecipientIdentity_guestPersonId_key" ON "TTLockRecipientIdentity"("guestPersonId");
CREATE UNIQUE INDEX "TTLockRecipientIdentity_username_key" ON "TTLockRecipientIdentity"("username");
CREATE INDEX "TTLockRecipientIdentity_status_idx" ON "TTLockRecipientIdentity"("status");
CREATE INDEX "TTLockRecipientIdentity_tokenExpiresAt_idx" ON "TTLockRecipientIdentity"("tokenExpiresAt");
ALTER TABLE "TTLockRecipientIdentity" ADD CONSTRAINT "TTLockRecipientIdentity_guestPersonId_fkey" FOREIGN KEY ("guestPersonId") REFERENCES "GuestPerson"("id") ON DELETE CASCADE ON UPDATE CASCADE;
