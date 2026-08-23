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

test("runtime dependencies remain wired to canonical pricing, Channex intent, and reconciliation services", async () => {
  const source = await read("./manual-reservation-date-change.service.ts");
  assert.match(source, /calculatePricing:\s*calculateDirectBookingPricing/);
  assert.match(source, /persistChannexIntent:\s*persistChannexAriReservationIntent/);
  assert.match(source, /reconcile:\s*reconcileReservation/);
  assert.match(source, /prisma,\s*\n\s*calculatePricing/);
});

test("manual date change preview recalculates canonical pricing without mutating the reservation", async () => {
  const source = await read("./manual-reservation-date-change.service.ts");
  assert.match(source, /previewManualReservationDateChangeByHost/);
  assert.match(source, /prepareManualReservationDateChange/);
  assert.match(source, /dependencies\.calculatePricing/);
  assert.match(source, /excludeReservationId:\s*reservation\.id/);
  assert.match(source, /paymentHandledOutsidePinGo:\s*true/);
  const previewStart = source.indexOf("export async function previewManualReservationDateChangeByHost");
  const confirmStart = source.indexOf("export async function changeManualReservationDatesByHost");
  const previewBody = source.slice(previewStart, confirmStart);
  assert.doesNotMatch(previewBody, /\.reservation\.update/);
  assert.doesNotMatch(previewBody, /persistChannexIntent/);
  assert.doesNotMatch(previewBody, /\.reconcile\(/);
});

test("confirmation is fenced by reservation version and reviewed proposed total", async () => {
  const source = await read("./manual-reservation-date-change.service.ts");
  assert.match(source, /expectedReservationUpdatedAt/);
  assert.match(source, /expectedProposedTotalAmount/);
  assert.match(source, /RESERVATION_CHANGED_REVIEW_REQUIRED/);
  assert.match(source, /PRICING_CHANGED_REVIEW_REQUIRED/);
  assert.match(source, /DATE_CHANGE_PREVIEW_REQUIRED/);
});

test("confirmed manual date change preserves Channex availability intent and operational reconciliation", async () => {
  const source = await read("./manual-reservation-date-change.service.ts");
  assert.match(source, /dependencies\.persistChannexIntent/);
  assert.match(source, /propertyTimezone:\s*prepared\.timezone/);
  assert.match(source, /await dependencies\.reconcile\(prepared\.reservation\.id\)/);
  assert.match(source, /totalAmount:\s*prepared\.proposedTotal/);
  assert.match(source, /pricingBreakdown/);
});

test("manual date change remains organization scoped, manual only, active only, and conflict safe", async () => {
  const source = await read("./manual-reservation-date-change.service.ts");
  assert.match(source, /property:\s*\{ organizationId: input\.organizationId \}/);
  assert.match(source, /ReservationStatus\.ACTIVE/);
  assert.match(source, /MANUAL_RESERVATION_REQUIRED/);
  assert.match(source, /RESERVATION_DATE_CHANGE_CONFLICT/);
});
