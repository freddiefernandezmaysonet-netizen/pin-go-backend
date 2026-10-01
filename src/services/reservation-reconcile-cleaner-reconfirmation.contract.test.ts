import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { planCleaningWindow } from "./reservation-cleaning-window";

async function readReservationReconcileService() {
  return readFile(
    new URL("./reservation.reconcile.service.ts", import.meta.url),
    "utf8"
  );
}

test("cleaner reconfirmation follows the turnover window instead of all reservation dates", async () => {
  const source = await readReservationReconcileService();

  assert.match(
    source,
    /const cleaningReconfirmationNeeded = cleaningWindow.requiresReconfirmation/
  );
  assert.match(
    source,
    /status:\s*\{\s*in:\s*\["PENDING", "CONFIRMED"\]/
  );
  assert.match(
    source,
    /previousCleaningConfirmation\.staffMemberId/
  );
});

const checkout = new Date("2026-10-02T15:00:00Z");
const base = {
  checkOut: checkout, previousCheckOut: new Date(checkout), enabled: true,
  offsetMinutes: 30, durationMinutes: 180,
  assignments: [{ role: "CLEANING", status: "ACTIVE", startsAt: new Date("2026-10-02T15:30:00Z"), endsAt: new Date("2026-10-02T18:30:00Z") }],
};

test("early check-in and guest access retries leave the unchanged cleaner schedule intact", () => {
  // Arrival is deliberately not an input to the turnover policy.
  const result = planCleaningWindow(base);
  assert.equal(result.requiresReconfirmation, false);
  assert.equal(result.startsAt.toISOString(), "2026-10-02T15:30:00.000Z");
  assert.equal(result.endsAt.toISOString(), "2026-10-02T18:30:00.000Z");
});

test("late checkout shifts cleaning with the configured offset and duration", () => {
  const result = planCleaningWindow({ ...base, checkOut: new Date("2026-10-02T17:00:00Z") });
  assert.equal(result.requiresReconfirmation, true);
  assert.equal(result.startsAt.toISOString(), "2026-10-02T17:30:00.000Z");
  assert.equal(result.endsAt.toISOString(), "2026-10-02T20:30:00.000Z");
});

test("checkout change requires new consent even without a card or previous arrival snapshot", () => {
  assert.equal(planCleaningWindow({ ...base, assignments: [], checkOut: new Date("2026-10-02T17:00:00Z") }).requiresReconfirmation, true);
});

test("live cleaner schedule drift requires consent; terminal and guest cards do not", () => {
  assert.equal(planCleaningWindow({ ...base, offsetMinutes: 60 }).requiresReconfirmation, true);
  assert.equal(planCleaningWindow({ ...base, durationMinutes: 120 }).requiresReconfirmation, true);
  for (const status of ["FAILED", "ENDED"]) {
    assert.equal(planCleaningWindow({ ...base, offsetMinutes: 60, assignments: [{ ...base.assignments[0], status }] }).requiresReconfirmation, false);
  }
  assert.equal(planCleaningWindow({ ...base, offsetMinutes: 60, assignments: [{ ...base.assignments[0], role: "GUEST" }] }).requiresReconfirmation, false);
});

test("missing snapshot alone does not invalidate unchanged cleaner consent", () => {
  assert.equal(planCleaningWindow({ ...base, previousCheckOut: null }).requiresReconfirmation, false);
});

test("legacy NFC policy does not silently activate a non-NFC cleaning flow", () => {
  assert.equal(planCleaningWindow({ ...base, enabled: false, checkOut: new Date("2026-10-02T17:00:00Z") }).requiresReconfirmation, false);
});

test("guest-triggered NFC loop skips unchanged cleaner cards; provisioning cannot be marked ended", async () => {
  const source = await readReservationReconcileService();
  assert.match(source, /if \(a.role === NfcAssignmentRole.CLEANING\) \{[\s\S]*?if \(!cleaningReconfirmationNeeded\) continue;/);
  const branch = source.slice(source.indexOf("if (a.role === NfcAssignmentRole.CLEANING)"));
  assert.ok(branch.indexOf('throw new Error("CLEANING_RECONFIRMATION_PROVISIONING_PENDING")') < branch.indexOf("status: NfcAssignmentStatus.ENDED"));
});

test("old cleaner authorization is closed before the replacement request is created", async () => {
  const source = await readReservationReconcileService();
  const renewal = await readFile(new URL("./cleaning-reconfirmation-renewal.service.ts", import.meta.url), "utf8");
  const cleaningBranch = source.indexOf(
    "if (a.role === NfcAssignmentRole.CLEANING)"
  );
  const expireConfirmations = renewal.indexOf(
    "await tx.cleaningConfirmation.updateMany"
  );
  const createConfirmation = renewal.indexOf(
    "const next = await tx.cleaningConfirmation.create"
  );
  const dispatchConfirmation = source.indexOf(
    "await dispatchPendingCleaningConfirmationForReservation"
  );

  assert.notEqual(cleaningBranch, -1);
  assert.notEqual(expireConfirmations, -1);
  assert.notEqual(createConfirmation, -1);
  assert.notEqual(dispatchConfirmation, -1);
  assert.ok(cleaningBranch < source.indexOf("await renewCleaningConfirmation"));
  assert.ok(expireConfirmations < createConfirmation);
  assert.ok(source.indexOf("await renewCleaningConfirmation") < dispatchConfirmation);

  const replacementFlow = source.slice(cleaningBranch, dispatchConfirmation) + renewal;

  assert.match(replacementFlow, /await ttlockChangeCardPeriod/);
  assert.match(
    replacementFlow,
    /status:\s*NfcAssignmentStatus\.ENDED/
  );
  assert.match(
    replacementFlow,
    /status:\s*"CANCELLED"/
  );
  assert.match(replacementFlow, /status:\s*"EXPIRED"/);
});

test("replacement and reconciliation snapshot share a transaction before dispatch", async () => {
  const source = await readFile(new URL("./cleaning-reconfirmation-renewal.service.ts", import.meta.url), "utf8");
  assert.match(source, /return await db.\$transaction/);
  const create = source.indexOf("await tx.cleaningConfirmation.create");
  const snapshot = source.indexOf("lastReconciledAt: now");
  assert.ok(create >= 0 && snapshot > create);
  assert.doesNotMatch(source, /dispatchPendingCleaningConfirmation/);
});
