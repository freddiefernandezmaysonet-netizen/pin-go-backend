import assert from "node:assert/strict";
import test from "node:test";

import {
  projectGuestAccessAmbiguityIssue,
  type GuestAccessMissionSnapshot,
} from "../e14/guest-access-readiness-mission-control.policy.e14";

const now = new Date("2026-09-01T10:00:00.000Z");

function snapshot(markerState: string | null): GuestAccessMissionSnapshot {
  return {
    reservationId: "r1",
    reservationNumber: "PG-2026-000001",
    guestName: "Guest",
    organizationId: "o1",
    propertyId: "p1",
    status: "ACTIVE",
    guestAccessReleaseStatus: "ELIGIBLE",
    checkIn: new Date("2026-09-01T12:00:00.000Z"),
    checkOut: new Date("2026-09-03T11:00:00.000Z"),
    accessGrants: [{
      status: "PENDING",
      providerCredentialPresent: false,
      secureCodePresent: false,
      recoveryOperation: "GUEST_ACCESS_PROVISION_AMBIGUOUS",
      recoveryNextAttemptAt: null,
      recoveryExhaustedAt: now,
      e15MarkerState: markerState as any,
    }],
  };
}

test("Closure A projects fresh E15 ambiguity as SYSTEM AUTO_RESOLVING", () => {
  const projection = projectGuestAccessAmbiguityIssue(snapshot(null), {
    now,
    e15Enabled: true,
  });
  assert.equal(projection.active, true);
  if (projection.active) {
    assert.equal(projection.workflowState, "AUTO_RESOLVING");
    assert.equal(projection.visibility, "SYSTEM");
    assert.equal(projection.actionRequired, false);
    assert.equal(projection.severity, "WARNING");
    assert.match(projection.nextAutomaticStep ?? "", /reconcile/i);
  }
});

test("Closure A keeps E15 manual conflict developer-critical", () => {
  const projection = projectGuestAccessAmbiguityIssue(
    snapshot("MANUAL_REVIEW_REQUIRED"),
    { now, e15Enabled: true }
  );
  assert.equal(projection.active, true);
  if (projection.active) {
    assert.equal(projection.workflowState, "ACTION_REQUIRED");
    assert.equal(projection.visibility, "DEVELOPER");
    assert.equal(projection.actionRequired, true);
    assert.equal(projection.severity, "CRITICAL");
  }
});

test("Closure A remains fail-closed when E15 is disabled", () => {
  const projection = projectGuestAccessAmbiguityIssue(snapshot(null), {
    now,
    e15Enabled: false,
  });
  assert.equal(projection.active, true);
  if (projection.active) {
    assert.equal(projection.workflowState, "ACTION_REQUIRED");
    assert.equal(projection.visibility, "DEVELOPER");
  }
});
