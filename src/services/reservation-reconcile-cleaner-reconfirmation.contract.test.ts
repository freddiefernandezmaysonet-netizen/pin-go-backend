import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

async function readReservationReconcileService() {
  return readFile(
    new URL("./reservation.reconcile.service.ts", import.meta.url),
    "utf8"
  );
}

test("date changes require a fresh cleaner confirmation when cleaning NFC is enabled", async () => {
  const source = await readReservationReconcileService();

  assert.match(
    source,
    /const cleaningReconfirmationNeeded =\s*reservationDatesChanged &&\s*reservation\.property\?\.cleaningNfcEnabled === true/
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

test("old cleaner authorization is closed before the replacement request is created", async () => {
  const source = await readReservationReconcileService();
  const cleaningBranch = source.indexOf(
    "if (a.role === NfcAssignmentRole.CLEANING)"
  );
  const expireConfirmations = source.indexOf(
    "await prisma.cleaningConfirmation.updateMany"
  );
  const createConfirmation = source.indexOf(
    "const confirmation = await createCleaningConfirmation"
  );
  const dispatchConfirmation = source.indexOf(
    "await dispatchPendingCleaningConfirmationForReservation"
  );

  assert.notEqual(cleaningBranch, -1);
  assert.notEqual(expireConfirmations, -1);
  assert.notEqual(createConfirmation, -1);
  assert.notEqual(dispatchConfirmation, -1);
  assert.ok(cleaningBranch < expireConfirmations);
  assert.ok(expireConfirmations < createConfirmation);
  assert.ok(createConfirmation < dispatchConfirmation);

  const replacementFlow = source.slice(cleaningBranch, dispatchConfirmation);

  assert.match(replacementFlow, /await ttlockChangeCardPeriod/);
  assert.match(
    replacementFlow,
    /status:\s*NfcAssignmentStatus\.ENDED/
  );
  assert.match(
    replacementFlow,
    /status:\s*StaffAssignmentStatus\.CANCELLED/
  );
  assert.match(replacementFlow, /status:\s*"EXPIRED"/);
});

test("the reconciliation snapshot is committed only after cleaner reconfirmation is prepared", async () => {
  const source = await readReservationReconcileService();
  const dispatchConfirmation = source.indexOf(
    "await dispatchPendingCleaningConfirmationForReservation"
  );
  const finalSnapshot = source.lastIndexOf(
    "lastReconciledCheckOut: desiredEnd"
  );

  assert.notEqual(dispatchConfirmation, -1);
  assert.notEqual(finalSnapshot, -1);
  assert.ok(dispatchConfirmation < finalSnapshot);
});
