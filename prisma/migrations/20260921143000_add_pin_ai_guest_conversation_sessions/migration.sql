CREATE TABLE "PinAIGuestConversation" (
    "id" TEXT NOT NULL,
    "reservationId" TEXT NOT NULL,
    "openaiSessionId" VARCHAR(160),
    "leaseToken" VARCHAR(64),
    "leaseExpiresAt" TIMESTAMP(3),
    "lastMessageAt" TIMESTAMP(3),
    "lastErrorCode" VARCHAR(120),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PinAIGuestConversation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PinAIGuestConversation_reservationId_key"
ON "PinAIGuestConversation"("reservationId");

CREATE UNIQUE INDEX "PinAIGuestConversation_openaiSessionId_key"
ON "PinAIGuestConversation"("openaiSessionId");

CREATE INDEX "PinAIGuestConversation_leaseExpiresAt_idx"
ON "PinAIGuestConversation"("leaseExpiresAt");

CREATE INDEX "PinAIGuestConversation_lastMessageAt_idx"
ON "PinAIGuestConversation"("lastMessageAt");

ALTER TABLE "PinAIGuestConversation"
ADD CONSTRAINT "PinAIGuestConversation_reservationId_fkey"
FOREIGN KEY ("reservationId") REFERENCES "Reservation"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
