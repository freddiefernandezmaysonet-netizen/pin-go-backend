-- Additive only: existing conversations and provider session identifiers remain intact.
ALTER TABLE "PinAIGuestConversation"
  ADD COLUMN "guestHistoryCiphertext" TEXT,
  ADD COLUMN "guestActionReceiptsCiphertext" TEXT;
