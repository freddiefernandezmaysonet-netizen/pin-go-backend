-- Add an optional global postal/ZIP code to Property.
-- Stored as text so leading zeroes and non-US postal formats are preserved.
ALTER TABLE "Property" ADD COLUMN "postalCode" TEXT;
