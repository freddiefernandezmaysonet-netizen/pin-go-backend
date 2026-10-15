import assert from "node:assert/strict";
import test from "node:test";
import { readDemoGuestNfcDiagnostics } from "./internal-demo-nfc-diagnostics.js";

test("read-only NFC diagnostics retain reservation windows and redact raw provider failures", async () => {
  let query: any;
  const startsAt = new Date("2026-10-11T19:00:00Z");
  const endsAt = new Date("2026-10-14T15:00:00Z");
  const output = await readDemoGuestNfcDiagnostics({ nfcCard: { findMany: async (input: any) => {
    query = input;
    return [{ label: "Guest-1", status: "ASSIGNED", NfcAssignment: [{
      status: "FAILED", startsAt, endsAt,
      lastError: "TTLOCK_EXPIRE_GUEST_FAILED: TTLock errcode=-2012 errmsg=synthetic-secret-do-not-return",
      Reservation: { reservationNumber: "PG-SYNTHETIC", status: "ACTIVE", checkOut: endsAt },
    }, { status: "SCHEDULED", startsAt, endsAt, lastError: null,
      Reservation: { reservationNumber: "PG-NEXT", status: "ACTIVE", checkOut: endsAt } },
    { status: "FAILED", startsAt, endsAt, lastError: "https://example.invalid/private-token",
      Reservation: { reservationNumber: "PG-OTHER", status: "CANCELLED", checkOut: endsAt } }] }];
  } } } as any, "synthetic-property");
  assert.equal(query.where.propertyId, "synthetic-property");
  assert.deepEqual(query.select.NfcAssignment.where.status.in, ["ACTIVE", "SCHEDULED", "PROVISIONING", "FAILED"]);
  assert.equal(output[0]!.assignments[0]!.providerCode, "-2012");
  assert.equal(output[0]!.assignments[0]!.errorCategory, "TTLOCK_EXPIRE_GUEST_FAILED");
  assert.equal(output[0]!.assignments[0]!.endsAt, endsAt);
  assert.equal(output[0]!.assignments[1]!.errorCategory, null);
  assert.equal(output[0]!.assignments[2]!.errorCategory, "NFC_OPERATION_FAILED");
  assert.doesNotMatch(JSON.stringify(output), /synthetic-secret|private-token|errmsg|lastError/);
});
