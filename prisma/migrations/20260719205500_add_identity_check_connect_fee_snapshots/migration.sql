ALTER TABLE "Reservation"
ADD COLUMN "basePlatformFeeAmount" DECIMAL(10,2),
ADD COLUMN "identityVerificationRequiredSnapshot" BOOLEAN;
