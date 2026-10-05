-- Preserve existing work IDs, consent, receipts and notices. A new confirmation
-- gets a new work record only after the previous current work is closed.
CREATE UNIQUE INDEX "CleaningWork_confirmation_scope_key"
  ON "CleaningWork" ("reservationId", "staffMemberId", "confirmationId");
CREATE INDEX "CleaningWork_reservationId_staffMemberId_idx"
  ON "CleaningWork" ("reservationId", "staffMemberId");
DROP INDEX "CleaningWork_reservationId_staffMemberId_key";
