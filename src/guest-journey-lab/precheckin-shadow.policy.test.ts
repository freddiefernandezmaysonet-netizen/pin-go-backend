import assert from "node:assert/strict";
import test from "node:test";
import { planPrecheckinShadow, type PrecheckinSnapshot } from "./precheckin-shadow.policy";

const now = new Date("2030-05-01T16:00:00Z");
const env = { OTA_GUEST_EXTERNAL_MESSAGING_BLOCKED_PROVIDERS: "AIRBNB,BOOKING_COM" };
const empty = { messages: [], dispatches: [] };
const base: PrecheckinSnapshot = {
  id: "synthetic-reservation", propertyId: "synthetic-property", organizationId: "synthetic-org",
  status: "ACTIVE", paymentState: "PAID", cancelledAt: null,
  createdAt: new Date("2030-04-01T16:00:00Z"),
  checkIn: new Date("2030-05-01T20:00:00Z"), checkOut: new Date("2030-05-03T15:00:00Z"),
  guestEmail: "guest@example.invalid", guestPhone: "+15005550006",
  source: "DIRECT_BOOKING", externalProvider: null, externalId: null,
  externalRaw: { consent: { smsConsent: true, acceptedAt: "2030-04-01T16:00:00Z" } },
};
const plan = (overrides: Partial<PrecheckinSnapshot> = {}, at = now) => planPrecheckinShadow({ ...base, ...overrides }, at, empty, env);
const required = (rows: ReturnType<typeof plan>) => rows.filter(row => row.state === "REQUIRED").map(row => row.channel);

test("a due Direct Booking reservation with no outbox yields separate email and SMS obligations", () => {
  const rows = plan();
  assert.deepEqual(required(rows), ["email", "sms"]);
  assert.ok(rows.every(row => row.owner === "COMMUNICATIONS" && !row.dispatchAllowed && row.claim === "NOT_CREATED"));
  assert.ok(rows.every(row => row.receipt === "NOT_CERTIFIED" && row.finalEvidence === "OBLIGATION_ONLY"));
  assert.equal(new Set(rows.map(row => row.effectKey)).size, 2);
});
test("four-hour and checkout boundaries, cancellation and payment match legacy eligibility", () => {
  assert.deepEqual(required(plan({}, new Date(now.getTime() - 1))), []);
  assert.deepEqual(required(plan()), ["email", "sms"]);
  for (const overrides of [{ status: "CANCELLED" }, { cancelledAt: now }, { paymentState: "PENDING" }])
    assert.deepEqual(required(plan(overrides)), []);
  assert.deepEqual(required(plan({}, base.checkOut)), []);
});
test("late consent creates only the missing SMS obligation and preserves the effect identity", () => {
  assert.deepEqual(required(plan({ externalRaw: null })), ["email"]);
  const prior = { messages: [], dispatches: [{ channel: "email", status: "SENT" }] };
  const rows = planPrecheckinShadow(base, now, prior, env);
  assert.deepEqual(required(rows), ["sms"]);
  assert.equal(rows[0].state, "EXISTING_EVIDENCE");
  assert.equal(rows[0].receipt, "NOT_CERTIFIED");
  assert.deepEqual(rows.map(row => row.effectKey), plan().map(row => row.effectKey));
});
test("SMS catch-up during stay and late-created reservations expose the current E7 mismatch", () => {
  const at = new Date(base.checkIn.getTime() + 3600000);
  const rows = plan({}, at);
  assert.deepEqual(required(rows), ["sms"]);
  assert.ok(rows[1].gaps.includes("E7_RETIRES_PRECHECKIN_AFTER_ARRIVAL"));
  assert.deepEqual(required(plan({ createdAt: at }, at)), ["email", "sms"]);
});
test("missing recipients and SMS consent never manufacture a send", () => {
  assert.deepEqual(required(plan({ guestEmail: null, guestPhone: null })), []);
  assert.deepEqual(required(plan({ guestEmail: null, externalRaw: null })), []);
});
for (const source of ["Airbnb", "Booking.com"]) test(`${source} has one canonical Channex obligation and no external fallback`, () => {
  const ota = { source, externalProvider: "CHANNEX", externalId: "synthetic-ota-booking" };
  const rows = plan(ota);
  assert.deepEqual(required(rows), ["channex"]);
  assert.equal(rows[0].owner, "CHANNEX_OPERATIONAL");
  assert.equal(rows[0].expectedIntent, "DELEGATE_TO_EXISTING_OWNER");
  assert.deepEqual(required(plan(ota, base.checkIn)), []);
  assert.ok(plan({ ...ota, guestEmail: null, guestPhone: null })[0].gaps.includes("LEGACY_WORKER_HAS_NO_ELIGIBLE_TRIGGER"));
});
test("SENT, failed and uncertain records all require reconciliation, never a second initial send", () => {
  for (const status of ["SENT", "FAILED", "FAILED_FINAL", "E7_SENDING", "APMS_PENDING", null]) {
    const rows = planPrecheckinShadow(base, now, { dispatches: [], messages: [{ channel: "sms", status }] }, env);
    assert.deepEqual(required(rows), ["email"]);
    assert.equal(rows[1].state, "EXISTING_EVIDENCE");
    assert.equal(rows[1].receipt, "NOT_CERTIFIED");
  }
});
test("stable keys isolate tenant, property and reservation and survive repeated observation", () => {
  const key = plan()[0].effectKey;
  assert.equal(plan({}, new Date(now.getTime() + 1000))[0].effectKey, key);
  assert.equal(plan({ guestEmail: "changed@example.invalid" })[0].effectKey, key);
  for (const field of ["organizationId", "propertyId", "id"] as const)
    assert.notEqual(plan({ [field]: "another-scope" })[0].effectKey, key);
});
test("invalid scope and dates fail visibly", () => {
  assert.throws(() => plan({ organizationId: "" }), /SCOPE_REQUIRED/);
  assert.throws(() => plan({ checkIn: new Date("invalid") }), /DATES_INVALID/);
  assert.throws(() => plan({ checkOut: base.checkIn }), /DATES_INVALID/);
});
