import assert from "node:assert/strict";
import test from "node:test";
import { toObservationalMissionControlSnapshot } from "./mission-control-observational.ts";

const generatedAt = new Date("2026-09-23T00:00:00.000Z");
function snapshot(autopilotStatus: unknown) {
  const issue = Object.freeze({
    issueCode: "LEGACY_DELIVERY_FAILED", severity: "CRITICAL", engine: "Messaging",
    workflowState: "ACTION_REQUIRED", visibility: "HOST", actionRequired: true,
    reservationNumber: "PG-2026-000001", reservationId: "fixture-reservation",
  });
  return Object.freeze({
    entityId: "fixture-property", generatedAt, autopilotStatus,
    engineHealth: Object.freeze([{ engine: "GUEST_JOURNEY", status: "ERROR" }]),
    guestJourneyMetrics: Object.freeze({ verificationPending: 1, readyForArrival: 0 }),
    freedomMetrics: Object.freeze({ minutesReturned: 15, interventionsAvoided: 1, autonomousDecisions: 1 }),
    autonomyScore: Object.freeze({ score: 50 }),
    confidenceScore: Object.freeze({ score: 60 }),
    operationalItems: Object.freeze([issue]), currentOperationalState: Object.freeze([issue]),
    hostActionQueue: Object.freeze([issue]), recommendedActions: Object.freeze([issue]),
    waitingItems: Object.freeze([{ workflowState: "WAITING", engine: "Cleaning" }]),
    autoResolvingItems: Object.freeze([{ workflowState: "AUTO_RESOLVING", engine: "Access" }]),
    recentlyResolved: Object.freeze([{ workflowState: "RESOLVED", engine: "Messaging" }]),
    activityHistory: Object.freeze([{ engine: "Guest Journey", status: "SUCCESS" }]),
    recentAuditEntries: Object.freeze([{ engine: "Reservation", status: "SUCCESS" }]),
  });
}

for (const status of ["ACTIVE", "PAUSED", "ERROR", "NEEDS_ATTENTION", null]) {
  test(`host reporting does not inherit global health ${String(status)}`, () => {
    const source = snapshot(status);
    const result = toObservationalMissionControlSnapshot(source);
    assert.equal(result.autopilotStatus, null);
    assert.equal(result.engineHealth, null);
    assert.equal(source.autopilotStatus, status);
    assert.notEqual(result, source);
  });
}

test("only the two global health fields change; every operational field is preserved", () => {
  const source = snapshot("ACTIVE");
  const result = toObservationalMissionControlSnapshot(source);
  assert.deepEqual(Object.keys(result).sort(), Object.keys(source).sort());
  for (const key of Object.keys(source)) {
    if (key === "autopilotStatus" || key === "engineHealth") continue;
    assert.strictEqual(result[key as keyof typeof result], source[key as keyof typeof source], key);
  }
  assert.equal(result.hostActionQueue[0]?.severity, "CRITICAL");
  assert.equal(result.hostActionQueue[0]?.actionRequired, true);
  assert.equal(result.hostActionQueue[0]?.reservationNumber, "PG-2026-000001");
});

test("explicit unknown health survives JSON serialization instead of becoming healthy or zero engines", () => {
  const result = JSON.parse(JSON.stringify(toObservationalMissionControlSnapshot(snapshot("PAUSED"))));
  assert.ok(Object.hasOwn(result, "autopilotStatus"));
  assert.ok(Object.hasOwn(result, "engineHealth"));
  assert.equal(result.autopilotStatus, null);
  assert.equal(result.engineHealth, null);
  assert.equal(result.guestJourneyMetrics.verificationPending, 1);
  assert.equal(result.hostActionQueue.length, 1);
});

test("missing or stale engine evidence never produces a positive health verdict", () => {
  for (const engineHealth of [null, undefined, [], [{ status: "HEALTHY", lastExecutionAt: "2000-01-01" }]]) {
    const result = toObservationalMissionControlSnapshot({ ...snapshot("ACTIVE"), engineHealth });
    assert.equal(result.autopilotStatus, null);
    assert.equal(result.engineHealth, null);
    assert.strictEqual(result.generatedAt, generatedAt);
  }
});
