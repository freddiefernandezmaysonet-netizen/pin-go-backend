import assert from "node:assert/strict";
import test from "node:test";

import {
  DamageCaseGuestResponse,
  DamageCaseStatus,
} from "@prisma/client";

import {
  projectDamageCaseToMissionControl,
  type DamageCaseMissionControlSource,
} from "./damage-case-mission-control.service.js";

function damageCase(
  overrides: Partial<DamageCaseMissionControlSource> = {}
): DamageCaseMissionControlSource {
  return {
    id: "damage-case-1",
    status: DamageCaseStatus.OPEN,
    guestResponse: DamageCaseGuestResponse.PENDING,
    createdAt: new Date("2026-09-23T10:00:00.000Z"),
    updatedAt: new Date("2026-09-23T11:00:00.000Z"),
    guestNotifiedAt: null,
    reservationId: "reservation-internal-1",
    reservation: {
      reservationNumber: "PG-2026-000001",
      guestName: "Guest Name",
      propertyId: "property-1",
      property: { organizationId: "organization-1" },
    },
    damageNoticeDelivery: null,
    closureNoticeDelivery: null,
    hostResponseDelivery: null,
    ...overrides,
  };
}

function project(
  overrides: Partial<DamageCaseMissionControlSource> = {}
) {
  return projectDamageCaseToMissionControl({
    damageCase: damageCase(overrides),
    maxMessageRetries: 3,
  });
}

test("uses one stable operational identity and preserves tenant scope", () => {
  const first = project();
  const second = project({ updatedAt: new Date("2026-09-23T12:00:00.000Z") });

  assert.equal(
    first.operationalKey,
    "PROPERTY_PROTECTION_DAMAGE_CASE:damage-case-1"
  );
  assert.equal(second.operationalKey, first.operationalKey);
  assert.equal(first.organizationId, "organization-1");
  assert.equal(first.propertyId, "property-1");
  assert.equal(first.reservationId, "reservation-internal-1");
  assert.equal(first.reservationNumber, "PG-2026-000001");
  assert.equal(first.actionTarget, "RESERVATION");
});

test("projects evidence, open and host-review states to the host action queue", () => {
  for (const status of [
    DamageCaseStatus.EVIDENCE_PENDING,
    DamageCaseStatus.OPEN,
    DamageCaseStatus.HOST_REVIEW,
  ]) {
    const result = project({ status });
    assert.equal(result.workflowState, "ACTION_REQUIRED");
    assert.equal(result.visibility, "HOST");
    assert.equal(result.responsibleActor, "HOST");
    assert.equal(result.actionRequired, true);
    assert.ok(result.recommendedAction);
  }
});

test("projects an active guest-notice retry as auto-resolving", () => {
  const result = project({
    status: DamageCaseStatus.GUEST_NOTIFICATION_PENDING,
    damageNoticeDelivery: { status: "FAILED", retryCount: 2 },
  });

  assert.equal(result.workflowState, "AUTO_RESOLVING");
  assert.equal(result.responsibleActor, "PIN_GO");
  assert.equal(result.actionRequired, false);
  assert.equal(result.canAutoResolve, true);
  assert.equal(result.autoResolveStatus, "AVAILABLE");
  assert.match(result.issue, /pending guest notification/i);
});

test("does not claim auto-resolution when delivery is missing or retries are exhausted", () => {
  for (const damageNoticeDelivery of [
    null,
    { status: "FAILED", retryCount: 3 },
    { status: "FAILED_FINAL", retryCount: 1 },
  ]) {
    const result = project({
      status: DamageCaseStatus.GUEST_NOTIFICATION_PENDING,
      damageNoticeDelivery,
    });

    assert.equal(result.workflowState, "ACTION_REQUIRED");
    assert.equal(result.actionRequired, true);
    assert.equal(result.canAutoResolve, false);
    assert.equal(result.autoResolveStatus, "NOT_SUPPORTED");
    assert.match(result.issue, /no charge was made/i);
  }
});

test("projects pending and acknowledged guest responses as waiting", () => {
  for (const guestResponse of [
    DamageCaseGuestResponse.PENDING,
    DamageCaseGuestResponse.ACKNOWLEDGED,
  ]) {
    const result = project({
      status: DamageCaseStatus.GUEST_NOTIFIED,
      guestResponse,
    });

    assert.equal(result.workflowState, "WAITING");
    assert.equal(result.actionRequired, false);
    assert.ok(result.nextAutomaticStep);
  }
});

test("waits after acceptance only when every host notice was delivered", () => {
  const result = project({
    status: DamageCaseStatus.GUEST_NOTIFIED,
    guestResponse: DamageCaseGuestResponse.ACCEPTED,
    hostResponseDelivery: {
      status: "SENT",
      recipientCount: 2,
      sentCount: 2,
      retryingCount: 0,
      failedFinalCount: 0,
      missingCount: 0,
    },
  });

  assert.equal(result.workflowState, "WAITING");
  assert.equal(result.actionRequired, false);
  assert.equal(result.metadata?.hostResponseDeliveryStatus, "SENT");
  assert.equal(result.metadata?.hostResponseSentCount, 2);
});

test("auto-resolves an accepted response while any host notice retries", () => {
  const result = project({
    status: DamageCaseStatus.GUEST_NOTIFIED,
    guestResponse: DamageCaseGuestResponse.ACCEPTED,
    hostResponseDelivery: {
      status: "RETRYING",
      recipientCount: 2,
      sentCount: 1,
      retryingCount: 1,
      failedFinalCount: 0,
      missingCount: 0,
    },
  });

  assert.equal(result.workflowState, "AUTO_RESOLVING");
  assert.equal(result.responsibleActor, "PIN_GO");
  assert.equal(result.canAutoResolve, true);
  assert.match(result.issue, /No charge was made/);
});

test("requires action when accepted-response host delivery is incomplete", () => {
  for (const status of [
    "DESTINATION_MISSING",
    "MISSING",
    "FAILED_FINAL",
  ] as const) {
    const result = project({
      status: DamageCaseStatus.GUEST_NOTIFIED,
      guestResponse: DamageCaseGuestResponse.ACCEPTED,
      hostResponseDelivery: {
        status,
        recipientCount: status === "DESTINATION_MISSING" ? 0 : 1,
        sentCount: 0,
        retryingCount: 0,
        failedFinalCount: status === "FAILED_FINAL" ? 1 : 0,
        missingCount: status === "MISSING" ? 1 : 0,
      },
    });

    assert.equal(result.workflowState, "ACTION_REQUIRED");
    assert.equal(result.actionRequired, true);
    assert.equal(result.canAutoResolve, false);
    assert.match(result.issue, /no charge was made/i);
  }
});

test("projects a guest dispute as host action required without charging", () => {
  const result = project({
    status: DamageCaseStatus.GUEST_NOTIFIED,
    guestResponse: DamageCaseGuestResponse.DISPUTED,
    hostResponseDelivery: {
      status: "SENT",
      recipientCount: 1,
      sentCount: 1,
      retryingCount: 0,
      failedFinalCount: 0,
      missingCount: 0,
    },
  });

  assert.equal(result.workflowState, "ACTION_REQUIRED");
  assert.equal(result.responsibleActor, "HOST");
  assert.match(result.issue, /No charge was made/);
  assert.match(result.recommendedAction ?? "", /close.*without charge/i);
});

test("projects no-charge closure as a resolved manual host outcome", () => {
  const result = project({
    status: DamageCaseStatus.CLOSED_NO_CHARGE,
  });

  assert.equal(result.workflowState, "RESOLVED");
  assert.equal(result.actionRequired, false);
  assert.equal(result.resolutionCode, "PROPERTY_PROTECTION_CLOSED_NO_CHARGE");
  assert.equal(result.resolutionType, "MANUAL");
  assert.equal(result.resolvedBy, "HOST");
  assert.match(result.issue, /without charging the guest/i);
});

test("keeps a never-visible no-charge closure resolved without requiring delivery", () => {
  const result = project({
    status: DamageCaseStatus.CLOSED_NO_CHARGE,
    guestNotifiedAt: null,
    closureNoticeDelivery: null,
  });

  assert.equal(result.workflowState, "RESOLVED");
  assert.equal(result.metadata?.closureNoticeRequired, false);
});

test("projects an active guest closure retry as auto-resolving", () => {
  const result = project({
    status: DamageCaseStatus.CLOSED_NO_CHARGE,
    guestNotifiedAt: new Date("2026-09-23T10:30:00.000Z"),
    closureNoticeDelivery: { status: "FAILED", retryCount: 2 },
  });

  assert.equal(result.workflowState, "AUTO_RESOLVING");
  assert.equal(result.responsibleActor, "PIN_GO");
  assert.equal(result.canAutoResolve, true);
  assert.match(result.issue, /closed without charge/i);
});

test("requires action when guest closure delivery is missing or exhausted", () => {
  for (const closureNoticeDelivery of [
    null,
    { status: "FAILED", retryCount: 3 },
    { status: "FAILED_FINAL", retryCount: 1 },
  ]) {
    const result = project({
      status: DamageCaseStatus.CLOSED_NO_CHARGE,
      guestNotifiedAt: new Date("2026-09-23T10:30:00.000Z"),
      closureNoticeDelivery,
    });

    assert.equal(result.workflowState, "ACTION_REQUIRED");
    assert.equal(result.actionRequired, true);
    assert.equal(result.canAutoResolve, false);
    assert.match(result.issue, /no charge was made/i);
  }
});

test("resolves a guest-visible closure only after confirmed delivery", () => {
  const result = project({
    status: DamageCaseStatus.CLOSED_NO_CHARGE,
    guestNotifiedAt: new Date("2026-09-23T10:30:00.000Z"),
    closureNoticeDelivery: { status: "SENT", retryCount: 1 },
  });

  assert.equal(result.workflowState, "RESOLVED");
  assert.equal(result.metadata?.closureNoticeDeliveryStatus, "SENT");
});

test("keeps CHARGE_BLOCKED defensive and non-executing", () => {
  const result = project({ status: DamageCaseStatus.CHARGE_BLOCKED });

  assert.equal(result.workflowState, "ACTION_REQUIRED");
  assert.equal(result.canAutoResolve, false);
  assert.equal(result.autoResolveActionCode, null);
  assert.match(result.issue, /No charge was made/);
});
