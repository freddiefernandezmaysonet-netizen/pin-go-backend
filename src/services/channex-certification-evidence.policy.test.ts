import assert from "node:assert/strict";
import test from "node:test";
import {
  buildChannexCertificationEvidence,
  toPublicChannexErrorCode,
  type ChannexCertificationEvidenceInput,
} from "./channex-certification-evidence.policy";

function baseInput(): ChannexCertificationEvidenceInput {
  return {
    revisionId: "revision-001",
    bookingId: "booking-001",
    bookingReference: "OTA-001",
    channexPropertyId: "channex-property-001",
    insertedAt: "2026-07-25T10:00:00.000Z",
    propertyId: "pin-go-property-001",
    persistence: {
      status: "SUCCESS",
      reason: "CHANNEX_REVISION_PERSISTED",
      completedAt: "2026-07-25T10:00:02.000Z",
    },
    acknowledgement: {
      status: "SUCCESS",
      reason: "CHANNEX_REVISION_ACKNOWLEDGED",
      completedAt: "2026-07-25T10:00:03.000Z",
    },
    event: {
      eventType: "booking",
      status: "PROCESSED",
      attempts: 1,
      lastErrorCode: null,
      receivedAt: "2026-07-25T10:00:00.000Z",
      processedAt: "2026-07-25T10:00:03.000Z",
      updatedAt: "2026-07-25T10:00:03.000Z",
    },
    reservation: {
      reservationNumber: "PG-2026-000100",
      status: "ACTIVE",
      externalProvider: "CHANNEX",
      externalId: "booking-001",
      externalUpdatedAt: "2026-07-25T10:00:00.000Z",
      lastIngestErrorCode: null,
      checkIn: "2026-08-01T19:00:00.000Z",
      checkOut: "2026-08-03T15:00:00.000Z",
      paymentState: "PAID",
      createdAt: "2026-07-25T10:00:01.000Z",
      updatedAt: "2026-07-25T10:00:02.000Z",
    },
    missionControl: {
      persistenceStatus: "PERSISTED",
      acknowledgementStatus: "SENT",
      eventStatus: "PROCESSED",
      nextAutomaticAction: "NONE",
      recoverable: false,
      hostActionRequired: false,
    },
  };
}

test("successful persistence, ACK and reservation correlation produce PASS", () => {
  const evidence = buildChannexCertificationEvidence(baseInput());

  assert.equal(evidence.outcome, "PASS");
  assert.equal(evidence.complete, true);
  assert.equal(evidence.verification.reservationMatches, true);
  assert.equal(evidence.verification.acknowledgementSent, true);
});

test("superseded revision with ACK and terminal event produces PASS_SUPERSEDED", () => {
  const input = baseInput();
  input.persistence = {
    status: "SKIPPED",
    reason: "CHANNEX_REVISION_SUPERSEDED_OR_ALREADY_PERSISTED",
    completedAt: "2026-07-25T10:00:02.000Z",
  };
  input.reservation = null;

  const evidence = buildChannexCertificationEvidence(input);

  assert.equal(evidence.outcome, "PASS_SUPERSEDED");
  assert.equal(evidence.complete, true);
});

test("failed ACK remains pending automatic recovery", () => {
  const input = baseInput();
  input.acknowledgement = {
    status: "FAILED",
    reason: "CHANNEX_REVISION_ACK_FAILED",
    completedAt: "2026-07-25T10:00:03.000Z",
  };
  input.event = {
    ...input.event!,
    status: "FAILED",
    lastErrorCode: "PIN_GO_CONNECT_REVISION_ACK_FAILED",
  };
  input.missionControl = {
    persistenceStatus: "PERSISTED",
    acknowledgementStatus: "FAILED",
    eventStatus: "FAILED",
    nextAutomaticAction: "RETRY_ACKNOWLEDGEMENT",
    recoverable: true,
    hostActionRequired: false,
  };

  const evidence = buildChannexCertificationEvidence(input);

  assert.equal(evidence.outcome, "PENDING_AUTOMATIC_RECOVERY");
  assert.equal(evidence.verification.acknowledgementFailed, true);
});

test("active-stay cancellation rejection requires action and no ACK", () => {
  const input = baseInput();
  input.persistence = {
    status: "FAILED",
    reason: "CHANNEX_CANCELLATION_NOT_APPLIED",
    completedAt: "2026-07-25T10:00:02.000Z",
  };
  input.acknowledgement = null;
  input.event = {
    ...input.event!,
    status: "FAILED",
    lastErrorCode: "PIN_GO_CONNECT_CANCELLATION_NOT_APPLIED",
  };
  input.reservation = {
    ...input.reservation!,
    lastIngestErrorCode: "CANCEL_REJECTED_ACTIVE_STAY",
  };
  input.missionControl = {
    persistenceStatus: "FAILED",
    acknowledgementStatus: "PENDING",
    eventStatus: "FAILED",
    nextAutomaticAction: "WAITING_FOR_HOST_REVIEW",
    recoverable: false,
    hostActionRequired: true,
  };

  const evidence = buildChannexCertificationEvidence(input);

  assert.equal(evidence.outcome, "ACTION_REQUIRED");
  assert.equal(evidence.verification.cancellationRejected, true);
  assert.equal(evidence.verification.acknowledgementSent, false);
});

test("missing reservation correlation produces FAIL_INCOMPLETE", () => {
  const input = baseInput();
  input.reservation = null;

  const evidence = buildChannexCertificationEvidence(input);

  assert.equal(evidence.outcome, "FAIL_INCOMPLETE");
  assert.equal(evidence.complete, false);
});

test("internal Channex errors are converted to Pin&Go Connect codes", () => {
  assert.equal(
    toPublicChannexErrorCode("CHANNEX_REVISION_ACK_FAILED:revision-001"),
    "PIN_GO_CONNECT_REVISION_ACK_FAILED"
  );
});
