import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  resolveGuestAccessAdmissionE14Config,
} from "./guest-access-admission-fence.config.e14.js";

const workerSource = readFileSync(
  new URL(
    "../workers/reservation.worker.ts",
    import.meta.url
  ),
  "utf8"
);
const serviceSource = readFileSync(
  new URL(
    "guest-access-admission-fence.service.e14.ts",
    import.meta.url
  ),
  "utf8"
);


test("E14 access admission is strict default-off and explicit opt-in", () => {
  assert.deepEqual(
    resolveGuestAccessAdmissionE14Config({}),
    { enabled: false, valid: true, source: "DEFAULT_OFF" }
  );
  assert.deepEqual(
    resolveGuestAccessAdmissionE14Config({
      GUEST_JOURNEY_E14_ACCESS_ADMISSION_ENABLED: "false",
    }),
    { enabled: false, valid: true, source: "ENV" }
  );
  assert.deepEqual(
    resolveGuestAccessAdmissionE14Config({
      GUEST_JOURNEY_E14_ACCESS_ADMISSION_ENABLED: "true",
    }),
    { enabled: true, valid: true, source: "ENV" }
  );
  assert.deepEqual(
    resolveGuestAccessAdmissionE14Config({
      GUEST_JOURNEY_E14_ACCESS_ADMISSION_ENABLED: "invalid",
    }),
    { enabled: false, valid: false, source: "INVALID_ENV" }
  );
});

test("E14 admission filters require explicit activation", () => {
  const fetchIndex = workerSource.indexOf(
    "async function fetchDueCheckins"
  );
  const checkoutIndex = workerSource.indexOf(
    "async function fetchDueCheckouts",
    fetchIndex
  );
  const source = workerSource.slice(fetchIndex, checkoutIndex);

  assert.match(
    source,
    /GUEST_ACCESS_ADMISSION_E14_CONFIG\.enabled[\s\S]*guestAccessReleaseStatus:[\s\S]*GuestAccessReleaseStatus\.ELIGIBLE/
  );
  assert.equal(
    (source.match(/guestAccessProvisionClaimableWhere\(now\)/g) ?? []).length,
    2
  );
  assert.ok(source.includes(": {}),"));
});

test("default-off preserves E13 activation while true opts into E14 fencing", () => {
  const processIndex = workerSource.indexOf(
    "async function processCheckins"
  );
  const nextIndex = workerSource.indexOf(
    "async function activateGuestNfcAssignmentsForReservation",
    processIndex
  );
  const source = workerSource.slice(processIndex, nextIndex);

  const gateIndex = source.indexOf(
    "if (GUEST_ACCESS_ADMISSION_E14_CONFIG.enabled)"
  );
  const fenceIndex = source.indexOf(
    "executeGuestAccessProvisioningWithFence(",
    gateIndex
  );
  const elseIndex = source.indexOf("} else {", fenceIndex);
  const legacyClaimIndex = source.indexOf(
    "// Confirma que el grant todavía está PENDING.",
    elseIndex
  );
  const legacyActivationIndex = source.indexOf(
    "await activateGrant(grant.id)",
    legacyClaimIndex
  );

  assert.ok(gateIndex >= 0);
  assert.ok(fenceIndex > gateIndex);
  assert.ok(elseIndex > fenceIndex);
  assert.ok(legacyClaimIndex > elseIndex);
  assert.ok(legacyActivationIndex > legacyClaimIndex);
});

test("E14.1 selects the canonical reservation-window target before entering the grant loop", () => {
  const processIndex = workerSource.indexOf(
    "async function processCheckins"
  );
  const nextIndex = workerSource.indexOf(
    "async function activateGuestNfcAssignmentsForReservation",
    processIndex
  );
  const source = workerSource.slice(processIndex, nextIndex);

  const selectorIndex = source.indexOf(
    "selectGuestAccessReservationTarget("
  );
  const loopIndex = source.indexOf(
    "for (const grant of accessGrantsToProcess)"
  );

  assert.match(
    source,
    /const accessGrantsToProcess =[\s\S]*GUEST_ACCESS_ADMISSION_E14_CONFIG\.enabled[\s\S]*selectGuestAccessReservationTarget\([\s\S]*reservation\.accessGrants[\s\S]*checkIn: reservation\.checkIn[\s\S]*checkOut: reservation\.checkOut[\s\S]*: reservation\.accessGrants;/
  );
  assert.ok(selectorIndex >= 0);
  assert.ok(loopIndex > selectorIndex);
});

test("E14 removes the five-grant fetch truncation while default-off retains it", () => {
  const fetchIndex = workerSource.indexOf(
    "async function fetchDueCheckins"
  );
  const checkoutIndex = workerSource.indexOf(
    "async function fetchDueCheckouts",
    fetchIndex
  );
  const source = workerSource.slice(fetchIndex, checkoutIndex);

  assert.match(
    source,
    /orderBy:\s*\{\s*startsAt:\s*"asc",\s*\},\s*\.\.\.\(GUEST_ACCESS_ADMISSION_E14_CONFIG\.enabled\s*\?\s*\{\}\s*:\s*\{\s*take:\s*5\s*\}\),\s*include:/
  );
  assert.equal(
    source.includes("\n        take: 5,\n        include: {"),
    false
  );
});

test("E14 safety reconciliation and related projection are default-off", () => {
  const tickIndex = workerSource.indexOf("async function tick()");
  const guardIndex = workerSource.indexOf(
    "GUEST_ACCESS_ADMISSION_E14_CONFIG.enabled &&",
    tickIndex
  );
  const safetyIndex = workerSource.indexOf(
    "runGuestAccessAdmissionSafetyCycle(",
    tickIndex
  );
  const checkinIndex = workerSource.indexOf(
    "await processCheckins(now)",
    tickIndex
  );

  assert.ok(guardIndex > tickIndex);
  assert.ok(safetyIndex > guardIndex);
  assert.ok(checkinIndex > safetyIndex);
});

test("invalid E14 configuration cannot activate the E14 runtime path", () => {
  assert.match(
    workerSource,
    /resolveGuestAccessAdmissionE14Config\(\s*process\.env\s*\)/
  );
  assert.equal(
    workerSource.includes(
      "GUEST_JOURNEY_E14_ACCESS_ADMISSION_ENABLED === '1'"
    ),
    false
  );
});

test("transaction-capable production clients route through the reservation singleton fence", () => {
  assert.match(
    serviceSource,
    /guest-access-reservation-singleton-fence\.e14\.js/
  );
  assert.match(
    serviceSource,
    /supportsReservationSingletonFence\(db\)[\s\S]*executeReservationSingleton\(db, input\)/
  );
  assert.match(
    serviceSource,
    /supportsReservationSingletonFence\(db\)[\s\S]*claimReservationSingleton\(db, input\)/
  );
});

test("E14.1 stops the reservation grant loop for every fenced outcome", () => {
  const processIndex = workerSource.indexOf(
    "async function processCheckins"
  );
  const nextIndex = workerSource.indexOf(
    "async function activateGuestNfcAssignmentsForReservation",
    processIndex
  );
  const source = workerSource.slice(processIndex, nextIndex);

  assert.match(
    source,
    /Guest access provisioning deferred by E14[\s\S]*?break;/
  );
  assert.match(
    source,
    /E14\.1 reservation singleton outcome complete[\s\S]*?break;/
  );
  assert.match(
    source,
    /E14\.1 reservation singleton orchestration failed[\s\S]*?break;/
  );

  const deferredIndex = source.indexOf(
    "Guest access provisioning deferred by E14"
  );
  const deferredEnd = source.indexOf("break;", deferredIndex);
  assert.equal(
    source.slice(deferredIndex, deferredEnd).includes("continue;"),
    false
  );
});

test("default-off legacy grant behavior remains present", () => {
  const processIndex = workerSource.indexOf(
    "async function processCheckins"
  );
  const nextIndex = workerSource.indexOf(
    "async function activateGuestNfcAssignmentsForReservation",
    processIndex
  );
  const source = workerSource.slice(processIndex, nextIndex);
  const legacyIndex = source.indexOf(
    "// Confirma que el grant todavía está PENDING."
  );

  assert.ok(legacyIndex >= 0);
  assert.match(
    source.slice(legacyIndex),
    /claimed\.count === 0[\s\S]*?continue;/
  );
  assert.match(
    source.slice(legacyIndex),
    /await activateGrant\(grant\.id\)/
  );
});


test("Access cutover fences current APMS work and preserves only out-of-window legacy debt", () => {
  const checkinIndex = workerSource.indexOf(
    "async function processCheckins"
  );
  const checkoutIndex = workerSource.indexOf(
    "async function processCheckouts"
  );
  const checkinSource = workerSource.slice(
    checkinIndex,
    checkoutIndex
  );
  const checkoutSource = workerSource.slice(
    checkoutIndex
  );

  assert.match(
    checkinSource,
    /resolveGuestJourneyAccessOwnerHandoff\([\s\S]*operation:\s*"PROVISION"[\s\S]*internalReconcile:[\s\S]*GUEST_JOURNEY_INTERNAL_RECONCILE_CONFIG[\s\S]*coordination:[\s\S]*GUEST_JOURNEY_COORDINATION_CONFIG/
  );
  assert.match(
    checkoutSource,
    /resolveGuestJourneyAccessOwnerHandoff\([\s\S]*operation:\s*"REVOKE"[\s\S]*internalReconcile:[\s\S]*GUEST_JOURNEY_INTERNAL_RECONCILE_CONFIG[\s\S]*coordination:[\s\S]*GUEST_JOURNEY_COORDINATION_CONFIG/
  );
  assert.match(checkinSource, /accessHandoff\.owner ===\s*"ACCESS_OWNER"/);
  assert.match(checkoutSource, /accessHandoff\.owner ===\s*"ACCESS_OWNER"/);
  assert.match(checkinSource, /accessHandoff\.owner ===\s*"APMS_PENDING"/);
  assert.match(checkoutSource, /accessHandoff\.owner ===\s*"APMS_PENDING"/);
  assert.match(checkinSource, /accessHandoff\.owner === "BLOCKED"/);
  assert.match(checkoutSource, /accessHandoff\.owner === "BLOCKED"/);

  const oldScopeOnlyYield =
    /if\s*\(\s*isGuestJourneyAccessOwnerScope\([\s\S]*?\)\s*\)\s*\{[\s\S]*?yielded to Guest Journey ACCESS owner/;
  assert.equal(oldScopeOnlyYield.test(checkinSource), false);
  assert.equal(oldScopeOnlyYield.test(checkoutSource), false);

  // LEGACY remains a real fallback only after the handoff resolver returns it.
  assert.match(checkinSource, /await activateGrant\(grant\.id\)/);
  assert.match(checkoutSource, /await deactivateGrant\(grant\.id\)/);
});
