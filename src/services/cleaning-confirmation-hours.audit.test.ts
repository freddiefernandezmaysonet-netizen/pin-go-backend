import test from "node:test";
import assert from "node:assert/strict";
import { isWithinCleaningMessageHours as check, deferredCleaningOfferNeedsHost } from "./cleaning-offer-hours.service.js";
test("Saturday and Sunday use the same 08:00 inclusive / 18:00 exclusive PR schedule", () => {
  for (const date of ["2026-10-10", "2026-10-11"]) {
    assert.equal(check("America/Puerto_Rico", new Date(`${date}T11:59:00Z`)), false);
    assert.equal(check("America/Puerto_Rico", new Date(`${date}T12:00:00Z`)), true);
    assert.equal(check("America/Puerto_Rico", new Date(`${date}T21:59:00Z`)), true);
    assert.equal(check("America/Puerto_Rico", new Date(`${date}T22:00:00Z`)), false);
  }
});
test("property timezone decides permitted hour independently", () => {
  const at = new Date("2026-10-10T12:00:00Z");
  assert.equal(check("America/Puerto_Rico", at), true);
  assert.equal(check("America/Los_Angeles", at), false);
});
test("quiet-hour deferral escalates only when waiting makes the committed work infeasible", () => {
  const input = { now: new Date("2026-10-07T22:00:00Z"), timezone: "America/Puerto_Rico",
    startsAt: new Date("2026-10-08T15:00:00Z"), endsAt: new Date("2026-10-08T19:00:00Z"), durationMinutes: 60 };
  assert.equal(deferredCleaningOfferNeedsHost(input), false);
  assert.equal(deferredCleaningOfferNeedsHost({ ...input, endsAt: new Date("2026-10-08T12:30:00Z") }), true);
  assert.equal(deferredCleaningOfferNeedsHost({ ...input, durationMinutes: null }), true);
});
