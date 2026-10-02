import assert from "node:assert/strict";
import test from "node:test";
import type { Prisma } from "@prisma/client";
import { readStayTimeDepartureCleaning } from "./stay-time-departure-cleaning.service.js";

const input = { organizationId: "org", propertyId: "property", reservationId: "stay",
  checkOut: new Date("2030-10-03T15:00Z"), cleaningStartOffsetMinutes: 30,
  now: new Date("2030-10-01T12:00Z") };
function fixture() {
  const work = { id: "work", propertyId: "property", staffMemberId: "cleaner", confirmationId: "confirmation",
    scheduledStartAt: new Date("2030-10-03T15:30Z"), durationCommitmentMinutes: 180,
    timingConsentVersion: "v1", timingConsentAcceptedAt: new Date("2030-10-01T11:00Z"),
    startConfirmedAt: null, completionConfirmedAt: null };
  const state: { works: any[]; confirmations: any[]; assignment: any } = {
    works: [work], confirmations: [{ id: "confirmation", propertyId: "property", staffMemberId: "cleaner", status: "CONFIRMED" }],
    assignment: { id: "assignment", cleaningDurationCommitmentMinutes: 180 },
  };
  const tx = { cleaningWork: { async findMany(args: any) {
    assert.deepEqual(args.where, { reservationId: "stay", cancelledAt: null, supersededAt: null });
    assert.equal(args.take, 2); return state.works;
  } }, cleaningConfirmation: { async findMany(args: any) {
    assert.deepEqual(args.where, { reservationId: "stay", status: { in: ["PENDING", "CONFIRMED"] } });
    return state.confirmations;
  } }, propertyStaff: { async findFirst(args: any) {
    assert.deepEqual(args.where, { propertyId: "property", staffMemberId: "cleaner", isActive: true,
      property: { organizationId: "org", status: "ACTIVE", cleaningNfcEnabled: true },
      staffMember: { organizationId: "org", isActive: true } });
    return state.assignment;
  } } } as unknown as Prisma.TransactionClient;
  return { state, read: () => readStayTimeDepartureCleaning(tx, input) };
}
test("departure plan binds the accepted assignment and actual duration", async () => {
  const f = fixture();
  f.state.works[0].durationCommitmentMinutes = 120;
  f.state.assignment.cleaningDurationCommitmentMinutes = 120;
  assert.deepEqual(await f.read(), { version: "departure_cleaning_v1", workId: "work", confirmationId: "confirmation",
    staffMemberId: "cleaner", assignmentId: "assignment", durationMinutes: 120, offsetMinutes: 30,
    scheduledStartAt: "2030-10-03T15:30:00.000Z", timingConsentVersion: "v1", timingConsentAcceptedAt: "2030-10-01T11:00:00.000Z" });
});
for (const [name, change] of Object.entries({
  "missing work": (s: any) => { s.works = []; },
  "ambiguous work": (s: any) => { s.works.push({ ...s.works[0], id: "other" }); },
  "wrong property": (s: any) => { s.works[0].propertyId = "other"; },
  "missing consent": (s: any) => { s.works[0].timingConsentAcceptedAt = null; },
  "future consent": (s: any) => { s.works[0].timingConsentAcceptedAt = new Date("2031-01-01"); },
  "unknown consent": (s: any) => { s.works[0].timingConsentVersion = ""; },
  "stale schedule": (s: any) => { s.works[0].scheduledStartAt = input.checkOut; },
  "started work": (s: any) => { s.works[0].startConfirmedAt = input.now; },
  "completed work": (s: any) => { s.works[0].completionConfirmedAt = input.now; },
  "short duration": (s: any) => { s.works[0].durationCommitmentMinutes = 14; },
  "long duration": (s: any) => { s.works[0].durationCommitmentMinutes = 1441; },
  "fractional duration": (s: any) => { s.works[0].durationCommitmentMinutes = 90.5; },
  "missing confirmation": (s: any) => { s.confirmations = []; },
  "ambiguous confirmation": (s: any) => { s.confirmations.push({ ...s.confirmations[0], id: "other" }); },
  "pending confirmation": (s: any) => { s.confirmations[0].status = "PENDING"; },
  "replaced confirmation": (s: any) => { s.confirmations[0].id = "other"; },
  "different cleaner": (s: any) => { s.confirmations[0].staffMemberId = "other"; },
  "foreign confirmation": (s: any) => { s.confirmations[0].propertyId = "other"; },
  "inactive assignment": (s: any) => { s.assignment = null; },
  "changed duration": (s: any) => { s.assignment.cleaningDurationCommitmentMinutes = 120; },
})) test(`departure plan rejects ${name}`, async () => {
  const f = fixture(); change(f.state);
  await assert.rejects(f.read(), /DEPARTURE_CLEANING_COMMITMENT_REQUIRED/);
});
