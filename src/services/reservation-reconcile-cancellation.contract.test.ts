import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

async function readReservationReconcileService() {
  return readFile(
    new URL("./reservation.reconcile.service.ts", import.meta.url),
    "utf8"
  );
}

function getCancelledReservationBranch(source: string) {
  const branchStart = source.indexOf(
    "if (reservation.status === ReservationStatus.CANCELLED)"
  );
  const activeBranchStart = source.indexOf(
    "// ACTIVE → compute plan (diff → apply)",
    branchStart
  );

  assert.notEqual(branchStart, -1);
  assert.notEqual(activeBranchStart, -1);
  assert.ok(branchStart < activeBranchStart);

  return source.slice(branchStart, activeBranchStart);
}

test("cancelled reservation deactivates grants through TTLock Brain before marking them revoked", async () => {
  const source = await readReservationReconcileService();
  const branch = getCancelledReservationBranch(source);
  const deactivateCall = branch.indexOf(
    "await deactivateGrant(grant.id)"
  );
  const revokedUpdate = branch.indexOf(
    "status: AccessStatus.REVOKED",
    deactivateCall
  );

  assert.notEqual(deactivateCall, -1);
  assert.notEqual(revokedUpdate, -1);
  assert.ok(deactivateCall < revokedUpdate);
  assert.match(
    branch,
    /grant\.status === AccessStatus\.ACTIVE \|\|\s*grant\.status === AccessStatus\.PENDING/
  );
});

test("grant revocation failure preserves the non-revoked state and records the error", async () => {
  const source = await readReservationReconcileService();
  const branch = getCancelledReservationBranch(source);
  const catchStart = branch.indexOf(
    "} catch (e: any) {",
    branch.indexOf("await deactivateGrant(grant.id)")
  );
  const nfcBranchStart = branch.indexOf(
    "// CANCELLED → close scheduled NFC",
    catchStart
  );

  assert.notEqual(catchStart, -1);
  assert.notEqual(nfcBranchStart, -1);

  const grantFailureBranch = branch.slice(
    catchStart,
    nfcBranchStart
  );

  assert.match(
    grantFailureBranch,
    /CANCELLED_REVOKE_FAILED/
  );
  assert.match(
    grantFailureBranch,
    /lastError:\s*revokeError/
  );
  assert.doesNotMatch(
    grantFailureBranch,
    /status:\s*AccessStatus\.REVOKED/
  );
  assert.doesNotMatch(
    grantFailureBranch,
    /lastError:\s*null/
  );
});

test("scheduled NFC closes without invoking TTLock", async () => {
  const source = await readReservationReconcileService();
  const branch = getCancelledReservationBranch(source);
  const scheduledStart = branch.indexOf(
    "if (a.status === NfcAssignmentStatus.SCHEDULED)"
  );
  const scheduledEnd = branch.indexOf(
    "if (",
    scheduledStart + 1
  );

  assert.notEqual(scheduledStart, -1);
  assert.notEqual(scheduledEnd, -1);

  const scheduledBranch = branch.slice(
    scheduledStart,
    scheduledEnd
  );

  assert.match(
    scheduledBranch,
    /status:\s*NfcAssignmentStatus\.ENDED/
  );
  assert.match(scheduledBranch, /continue/);
  assert.doesNotMatch(
    scheduledBranch,
    /ttlockChangeCardPeriod/
  );
});

test("active and provisioning NFC use the existing physical revocation lifecycle", async () => {
  const source = await readReservationReconcileService();
  const branch = getCancelledReservationBranch(source);

  assert.match(
    branch,
    /a\.status !== NfcAssignmentStatus\.ACTIVE &&\s*a\.status !== NfcAssignmentStatus\.PROVISIONING/
  );
  assert.match(branch, /await ttlockChangeCardPeriod\(\{/);

  const physicalRevokeCall = branch.indexOf(
    "await ttlockChangeCardPeriod({"
  );
  const endedUpdate = branch.indexOf(
    "status: NfcAssignmentStatus.ENDED",
    physicalRevokeCall
  );

  assert.notEqual(physicalRevokeCall, -1);
  assert.notEqual(endedUpdate, -1);
  assert.ok(physicalRevokeCall < endedUpdate);
});

test("NFC physical revoke failure records an error without declaring the assignment ended", async () => {
  const source = await readReservationReconcileService();
  const branch = getCancelledReservationBranch(source);
  const physicalRevokeCall = branch.indexOf(
    "await ttlockChangeCardPeriod({"
  );
  const catchStart = branch.indexOf(
    "} catch (e: any) {",
    physicalRevokeCall
  );

  assert.notEqual(physicalRevokeCall, -1);
  assert.notEqual(catchStart, -1);

  const failureBranch = branch.slice(catchStart);

  assert.match(failureBranch, /CANCELLED_REVOKE_FAILED/);
  assert.match(failureBranch, /lastError:/);
  assert.doesNotMatch(
    failureBranch,
    /status:\s*NfcAssignmentStatus\.ENDED/
  );
});

test("ended and failed NFC assignments are not reprocessed during cancellation", async () => {
  const source = await readReservationReconcileService();
  const branch = getCancelledReservationBranch(source);

  assert.match(
    branch,
    /a\.status !== NfcAssignmentStatus\.ACTIVE &&\s*a\.status !== NfcAssignmentStatus\.PROVISIONING\s*\) \{\s*continue;/
  );
  assert.doesNotMatch(
    branch,
    /a\.status === NfcAssignmentStatus\.FAILED/
  );
});
