import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workerSource = readFileSync(
  new URL(
    "../workers/reservation.worker.ts",
    import.meta.url
  ),
  "utf8"
);

test("legacy check-in selection admits only persisted ELIGIBLE grants", () => {
  assert.match(
    workerSource,
    /guestAccessReleaseStatus:\s*\n\s*GuestAccessReleaseStatus\.ELIGIBLE/
  );

  const claimabilityMatches =
    workerSource.match(
      /guestAccessProvisionClaimableWhere\(now\)/g
    ) ?? [];

  assert.equal(
    claimabilityMatches.length,
    2,
    "claimability must fence both selection and included grants"
  );
});

test("legacy pseudo-claim is replaced by E14 claim and execution fencing", () => {
  assert.equal(
    workerSource.includes(
      "// Confirma que el grant todavía está PENDING."
    ),
    false
  );
  assert.equal(
    workerSource.includes(
      "executeGuestAccessProvisioningWithFence"
    ),
    true
  );

  const fenceIndex = workerSource.indexOf(
    "executeGuestAccessProvisioningWithFence("
  );
  const physicalIndex = workerSource.indexOf(
    "executePhysical: () =>"
  );
  const activationIndex = workerSource.indexOf(
    "activateGrant(grant.id)",
    physicalIndex
  );

  assert.ok(fenceIndex >= 0);
  assert.ok(physicalIndex > fenceIndex);
  assert.ok(activationIndex > physicalIndex);
});

test("read-only safety reconciliation runs before legacy check-in execution", () => {
  const tickIndex = workerSource.indexOf(
    "async function tick()"
  );
  const safetyIndex = workerSource.indexOf(
    "runGuestAccessAdmissionSafetyCycle(",
    tickIndex
  );
  const checkinIndex = workerSource.indexOf(
    "await processCheckins(now)",
    tickIndex
  );

  assert.ok(tickIndex >= 0);
  assert.ok(safetyIndex > tickIndex);
  assert.ok(checkinIndex > safetyIndex);
});

test("safety-cycle crashes remain rate-limited instead of retrying every worker tick", () => {
  const tickIndex = workerSource.indexOf(
    "async function tick()"
  );
  const timestampIndex = workerSource.indexOf(
    "lastGuestAccessAdmissionSafetyAt =",
    tickIndex
  );
  const safetyIndex = workerSource.indexOf(
    "runGuestAccessAdmissionSafetyCycle(",
    tickIndex
  );

  assert.ok(timestampIndex > tickIndex);
  assert.ok(safetyIndex > timestampIndex);
});
