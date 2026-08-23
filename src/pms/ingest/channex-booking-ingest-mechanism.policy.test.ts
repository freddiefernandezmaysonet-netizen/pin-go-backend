import assert from "node:assert/strict";
import test from "node:test";
import { requireAllowedChannexBookingIngestMechanism } from "./channex-booking-ingest-mechanism.policy";

test("accepts only Booking Revision by ID and Booking Revision Feed", () => {
  assert.equal(
    requireAllowedChannexBookingIngestMechanism("BOOKING_REVISION_BY_ID"),
    "BOOKING_REVISION_BY_ID"
  );
  assert.equal(
    requireAllowedChannexBookingIngestMechanism("booking-revision-feed"),
    "BOOKING_REVISION_FEED"
  );
});

test("rejects every Booking Find, booking-by-id, and Booking List mechanism", () => {
  const forbiddenMechanisms = [
    "BOOKING_FIND",
    "booking-by-id",
    "BOOKING_LIST",
    "booking list polling",
    "booking_received_via_booking_find",
  ];

  for (const mechanism of forbiddenMechanisms) {
    assert.throws(
      () => requireAllowedChannexBookingIngestMechanism(mechanism),
      /CHANNEX_BOOKING_FIND_FORBIDDEN/
    );
  }
});

test("rejects missing and unknown ingest mechanisms", () => {
  for (const mechanism of [null, undefined, "", "WEBHOOK", "UNKNOWN"]) {
    assert.throws(
      () => requireAllowedChannexBookingIngestMechanism(mechanism),
      /CHANNEX_BOOKING_INGEST_MECHANISM_UNSUPPORTED/
    );
  }
});
