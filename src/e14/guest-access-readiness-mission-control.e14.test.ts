import assert from "node:assert/strict";
import test from "node:test";

import {
  projectGuestAccessAmbiguityIssue,
  projectGuestAccessReadinessIssue,
  projectGuestAccessRecoveryIssue,
  shouldPersistGuestAccessOperationalSignal,
  shouldRunGuestAccessReadinessSafetyEvaluation,
  type GuestAccessMissionSnapshot,
} from "./guest-access-readiness-mission-control.policy.e14.js";

const NOW = new Date("2026-08-27T00:00:00.000Z");

function snapshot(
  overrides: Partial<GuestAccessMissionSnapshot> = {}
): GuestAccessMissionSnapshot {
  return {
    reservationId: "reservation-1",
    reservationNumber: "PG-2026-000100",
    guestName: "Guest",
    organizationId: "org-1",
    propertyId: "property-1",
    status: "ACTIVE",
    guestAccessReleaseStatus: "BLOCKED",
    checkIn: new Date("2026-08-28T15:00:00.000Z"),
    checkOut: new Date("2026-08-30T11:00:00.000Z"),
    accessGrants: [
      {
        status: "PENDING",
        providerCredentialPresent: false,
        secureCodePresent: false,
        recoveryOperation: null,
        recoveryNextAttemptAt: null,
        recoveryExhaustedAt: null,
      },
    ],
    ...overrides,
  };
}

test("blocked readiness far from arrival is a sanitized HOST WAITING issue", () => {
  const result = projectGuestAccessReadinessIssue(snapshot(), {
    now: NOW,
  });

  assert.equal(result.active, true);
  if (!result.active) return;
  assert.equal(result.workflowState, "WAITING");
  assert.equal(result.visibility, "HOST");
  assert.equal(result.responsibleActor, "GUEST");
  assert.equal(result.actionRequired, false);

  const exposed = JSON.stringify(result).toUpperCase();
  for (const forbidden of [
    "IDENTITY",
    "DOCUMENT",
    "PASSPORT",
    "DRIVER",
    "STRIPE",
    "SESSION_ID",
  ]) {
    assert.equal(exposed.includes(forbidden), false);
  }
});

test("blocked readiness inside the two-hour window becomes HOST ACTION_REQUIRED", () => {
  const result = projectGuestAccessReadinessIssue(
    snapshot({
      checkIn: new Date(NOW.getTime() + 90 * 60_000),
    }),
    { now: NOW }
  );

  assert.equal(result.active, true);
  if (!result.active) return;
  assert.equal(result.workflowState, "ACTION_REQUIRED");
  assert.equal(result.visibility, "HOST");
  assert.equal(result.responsibleActor, "HOST");
  assert.equal(result.actionRequired, true);
  assert.ok(result.recommendedAction);
});

test("eligible, released, active-grant, cancelled and ended states resolve automatically", () => {
  const cases = [
    snapshot({ guestAccessReleaseStatus: "ELIGIBLE" }),
    snapshot({ guestAccessReleaseStatus: "RELEASED" }),
    snapshot({
      accessGrants: [
        {
          status: "ACTIVE",
          providerCredentialPresent: true,
          secureCodePresent: true,
          recoveryOperation: null,
          recoveryNextAttemptAt: null,
          recoveryExhaustedAt: null,
        },
      ],
    }),
    snapshot({ status: "CANCELLED" }),
    snapshot({ checkOut: new Date(NOW.getTime() - 1) }),
  ];

  for (const item of cases) {
    const result = projectGuestAccessReadinessIssue(item, {
      now: NOW,
    });
    assert.equal(result.active, false);
  }
});

test("retryable, claimed and executing fences project a SYSTEM AUTO_RESOLVING issue", () => {
  for (const recoveryOperation of [
    "GUEST_ACCESS_PROVISION_RETRYABLE",
    "GUEST_ACCESS_PROVISION_CLAIMED:" + "a".repeat(64),
    "GUEST_ACCESS_PROVISION_EXECUTING:" + "b".repeat(64),
  ]) {
    const result = projectGuestAccessRecoveryIssue(
      snapshot({
        guestAccessReleaseStatus: "ELIGIBLE",
        accessGrants: [
          {
            status: "PENDING",
            providerCredentialPresent: false,
            secureCodePresent: false,
            recoveryOperation,
            recoveryNextAttemptAt:
              new Date(NOW.getTime() + 60_000),
            recoveryExhaustedAt: null,
          },
        ],
      }),
      { now: NOW }
    );

    assert.equal(result.active, true);
    if (!result.active) continue;
    assert.equal(result.workflowState, "AUTO_RESOLVING");
    assert.equal(result.visibility, "SYSTEM");
    assert.equal(result.responsibleActor, "PIN_GO");
    assert.equal(result.actionRequired, false);
    assert.ok(result.nextAutomaticStep);
  }
});

test("automatic recovery issue resolves on success or terminal reservation state", () => {
  const recovered = projectGuestAccessRecoveryIssue(
    snapshot({
      guestAccessReleaseStatus: "RELEASED",
      accessGrants: [
        {
          status: "ACTIVE",
          providerCredentialPresent: true,
          secureCodePresent: true,
          recoveryOperation: null,
          recoveryNextAttemptAt: null,
          recoveryExhaustedAt: null,
        },
      ],
    }),
    { now: NOW }
  );
  assert.equal(recovered.active, false);

  const cancelled = projectGuestAccessRecoveryIssue(
    snapshot({
      status: "CANCELLED",
      accessGrants: [
        {
          status: "PENDING",
          providerCredentialPresent: false,
          secureCodePresent: false,
          recoveryOperation:
            "GUEST_ACCESS_PROVISION_RETRYABLE",
          recoveryNextAttemptAt: NOW,
          recoveryExhaustedAt: null,
        },
      ],
    }),
    { now: NOW }
  );
  assert.equal(cancelled.active, false);
});

test("uncertain physical execution becomes a developer-only critical issue", () => {
  const result = projectGuestAccessAmbiguityIssue(
    snapshot({
      accessGrants: [
        {
          status: "PENDING",
          providerCredentialPresent: false,
          secureCodePresent: false,
          recoveryOperation:
            "GUEST_ACCESS_PROVISION_AMBIGUOUS",
          recoveryNextAttemptAt: null,
          recoveryExhaustedAt: NOW,
        },
      ],
    }),
    { now: NOW }
  );

  assert.equal(result.active, true);
  if (!result.active) return;
  assert.equal(result.workflowState, "ACTION_REQUIRED");
  assert.equal(result.visibility, "DEVELOPER");
  assert.equal(result.severity, "CRITICAL");
  assert.equal(result.canAutoResolve, true);

  const metadata = JSON.stringify(result.metadata).toUpperCase();
  assert.equal(metadata.includes("ERROR"), false);
  assert.equal(metadata.includes("TOKEN"), false);
  assert.equal(metadata.includes("PASSCODE"), false);
});

test("an unexpected recovery operation on a pending grant is developer-visible", () => {
  const result = projectGuestAccessAmbiguityIssue(
    snapshot({
      accessGrants: [
        {
          status: "PENDING",
          providerCredentialPresent: false,
          secureCodePresent: false,
          recoveryOperation: "REVOKE",
          recoveryNextAttemptAt: null,
          recoveryExhaustedAt: null,
        },
      ],
    }),
    { now: NOW }
  );

  assert.equal(result.active, true);
  if (!result.active) return;
  assert.equal(result.visibility, "DEVELOPER");
  assert.equal(result.severity, "CRITICAL");
});

test("ACTIVE without complete durable credential evidence does not hide ambiguity", () => {
  const result = projectGuestAccessAmbiguityIssue(
    snapshot({
      accessGrants: [
        {
          status: "ACTIVE",
          providerCredentialPresent: true,
          secureCodePresent: false,
          recoveryOperation:
            "GUEST_ACCESS_PROVISION_AMBIGUOUS",
          recoveryNextAttemptAt: null,
          recoveryExhaustedAt: NOW,
        },
      ],
    }),
    { now: NOW }
  );

  assert.equal(result.active, true);
  if (!result.active) return;
  assert.equal(result.visibility, "DEVELOPER");
});

test("active access does not resolve ambiguity without same-operation reconciliation", () => {
  const active = projectGuestAccessAmbiguityIssue(
    snapshot({
      accessGrants: [
        {
          status: "ACTIVE",
          providerCredentialPresent: true,
          secureCodePresent: true,
          recoveryOperation:
            "GUEST_ACCESS_PROVISION_AMBIGUOUS",
          recoveryNextAttemptAt: null,
          recoveryExhaustedAt: NOW,
        },
      ],
    }),
    { now: NOW }
  );
  assert.equal(active.active, true);

  const cancelled = projectGuestAccessAmbiguityIssue(
    snapshot({
      status: "CANCELLED",
      accessGrants: [
        {
          status: "PENDING",
          providerCredentialPresent: false,
          secureCodePresent: false,
          recoveryOperation:
            "GUEST_ACCESS_PROVISION_AMBIGUOUS",
          recoveryNextAttemptAt: null,
          recoveryExhaustedAt: NOW,
        },
      ],
    }),
    { now: NOW }
  );
  assert.equal(cancelled.active, false);
});


test("safety evaluation bootstraps only uninitialized readiness and does not poll persisted blockers", () => {
  assert.equal(
    shouldRunGuestAccessReadinessSafetyEvaluation(
      {
        status: "ACTIVE",
        checkOut: new Date(NOW.getTime() + 60_000),
        guestAccessReleaseStatus: "BLOCKED",
        guestAccessReleaseLastError: null,
      },
      NOW
    ),
    true
  );

  assert.equal(
    shouldRunGuestAccessReadinessSafetyEvaluation(
      {
        status: "ACTIVE",
        checkOut: new Date(NOW.getTime() + 60_000),
        guestAccessReleaseStatus: "BLOCKED",
        guestAccessReleaseLastError:
          "GUEST_IDENTITY_NOT_VERIFIED",
      },
      NOW
    ),
    false
  );

  assert.equal(
    shouldRunGuestAccessReadinessSafetyEvaluation(
      {
        status: "ACTIVE",
        checkOut: new Date(NOW.getTime() + 60_000),
        guestAccessReleaseStatus: "ELIGIBLE",
        guestAccessReleaseLastError: null,
      },
      NOW
    ),
    false
  );
});


test("stable operational issues are deduplicated between five-minute refreshes", () => {
  assert.equal(
    shouldPersistGuestAccessOperationalSignal({
      existingWorkflowState: "WAITING",
      existingLastSignalAt: new Date(NOW.getTime() - 60_000),
      nextWorkflowState: "WAITING",
      now: NOW,
    }),
    false
  );

  assert.equal(
    shouldPersistGuestAccessOperationalSignal({
      existingWorkflowState: "WAITING",
      existingLastSignalAt: new Date(NOW.getTime() - 60_000),
      nextWorkflowState: "ACTION_REQUIRED",
      now: NOW,
    }),
    true
  );

  assert.equal(
    shouldPersistGuestAccessOperationalSignal({
      existingWorkflowState: "WAITING",
      existingLastSignalAt: new Date(NOW.getTime() - 5 * 60_000),
      nextWorkflowState: "WAITING",
      now: NOW,
    }),
    true
  );
});
