CREATE TYPE "DirectBookingCheckoutDecision" AS ENUM ('BOOKED', 'REVIEW');

CREATE TABLE "DirectBookingCheckoutOutcome" (
    "key" TEXT NOT NULL,
    "decision" "DirectBookingCheckoutDecision" NOT NULL,
    "organizationId" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "bookingEventKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DirectBookingCheckoutOutcome_pkey" PRIMARY KEY ("key"),
    CONSTRAINT "DirectBookingCheckoutOutcome_booking_owner_check" CHECK (
      ("decision" = 'BOOKED' AND "bookingEventKey" IS NOT NULL) OR
      ("decision" = 'REVIEW' AND "bookingEventKey" IS NULL)
    )
);
