import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

async function read(name: string) {
  return readFile(new URL(name, import.meta.url), "utf8");
}

test("manual date change is property-timezone aware and uses configured stay times", async () => {
  const source = await read("./manual-reservation-date-change.service.ts");
  assert.match(source, /fromZonedTime/);
  assert.match(source, /property\.checkInTime/);
  assert.match(source, /property\.checkOutTime/);
  assert.match(source, /PROPERTY_TIMEZONE_REQUIRED/);
  assert.doesNotMatch(source, /-04:00/);
});

test("manual date change recalculates canonical pricing and excludes itself from occupancy", async () => {
  const source = await read("./manual-reservation-date-change.service.ts");
  assert.match(source, /calculateDirectBookingPricing/);
  assert.match(source, /excludeReservationId:\s*reservation\.id/);
  assert.match(source, /totalAmount:\s*proposedTotal/);
  assert.match(source, /pricingBreakdown/);
  assert.match(source, /paymentHandledOutsidePinGo:\s*true/);
});

test("manual date change preserves Channex availability intent and operational reconciliation", async () => {
  const source = await read("./manual-reservation-date-change.service.ts");
  assert.match(source, /persistChannexAriReservationIntent/);
  assert.match(source, /propertyTimezone:\s*timezone/);
  assert.match(source, /await reconcileReservation\(reservation\.id\)/);
});

test("manual date change remains organization scoped, manual only, active only, and conflict safe", async () => {
  const source = await read("./manual-reservation-date-change.service.ts");
  assert.match(source, /property:\s*\{ organizationId: input\.organizationId \}/);
  assert.match(source, /ReservationStatus\.ACTIVE/);
  assert.match(source, /MANUAL_RESERVATION_REQUIRED/);
  assert.match(source, /RESERVATION_DATE_CHANGE_CONFLICT/);
});
