-- Capture first confirmation in the reservation transaction, across every writer.
-- There is intentionally no backfill and no network side effect.
CREATE TABLE "HostMobileReservationEvent" (
  "reservationId" TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL,
  "propertyId" TEXT NOT NULL,
  "occurredAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "HostMobileReservationEvent_occurredAt_idx" ON "HostMobileReservationEvent"("occurredAt");
CREATE FUNCTION host_mobile_capture_reservation() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO "HostMobileReservationEvent" ("reservationId", "organizationId", "propertyId")
      SELECT NEW."id", p."organizationId", NEW."propertyId" FROM "Property" p WHERE p."id" = NEW."propertyId"
      ON CONFLICT ("reservationId") DO NOTHING;
  END IF;
  IF NEW."status" = 'ACTIVE' AND NEW."checkOut" > (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
    AND (COALESCE(NEW."source", '') <> 'DIRECT_BOOKING' AND COALESCE(NEW."externalProvider", '') <> 'PIN_GO_DIRECT'
      OR NEW."paymentState" = 'PAID') THEN
    UPDATE "HostMobileReservationEvent" SET "occurredAt" = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
      WHERE "reservationId" = NEW."id" AND "propertyId" = NEW."propertyId" AND "occurredAt" IS NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER host_mobile_reservation_created
  AFTER INSERT OR UPDATE OF "status", "paymentState" ON "Reservation"
  FOR EACH ROW EXECUTE FUNCTION host_mobile_capture_reservation();
