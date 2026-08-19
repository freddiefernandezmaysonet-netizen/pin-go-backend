import assert from "node:assert/strict";
import test from "node:test";
import {
  certifyChannexBookingReceivingScenario,
  type ChannexCertificationBookingRevisionEvidence,
} from "./channex-certification-booking-receiving.policy";
import { CHANNEX_CERTIFICATION_V1_MANIFEST } from "./channex-certification-v1.fixture";

const REJECTED_CERTIFICATION_REVISION_IDS = {
  NEW: "640268f5-9d5c-471e-93bc-53ddd93dabd0",
  MODIFICATION: "cbbeb9f0-6923-4139-8b48-4077e96143f9",
  CANCELLATION: "e3b6545e-edba-4148-93ec-d18de02eaf5e",
} as const;

function validRevision(args: {
  lifecycle: ChannexCertificationBookingRevisionEvidence["lifecycle"];
  persistenceCompletedAt: string;
  acknowledgementStartedAt: string;
}): ChannexCertificationBookingRevisionEvidence {
  return {
    lifecycle: args.lifecycle,
    revisionId: REJECTED_CERTIFICATION_REVISION_IDS[args.lifecycle],
    bookingId: "certification-booking-001",
    pinGoReservationId: "certification-reservation-001",
    pinGoPropertyId: CHANNEX_CERTIFICATION_V1_MANIFEST.propertyId,
    channexPropertyId:
      CHANNEX_CERTIFICATION_V1_MANIFEST.channexPropertyId,
    externalProvider: "CHANNEX",
    reservationStatus:
      args.lifecycle === "CANCELLATION" ? "CANCELLED" : "ACTIVE",
    reservationCountForBooking: 1,
    ingestMechanism: "BOOKING_REVISION_FEED",
    webhookHttpStatus: 200,
    webhookDeliveryNotesSuccess: true,
    eventStatus: "PROCESSED",
    persistenceStatus: "SUCCESS",
    persistenceCompletedAt: args.persistenceCompletedAt,
    acknowledgementStatus: "SUCCESS",
    acknowledgementStartedAt: args.acknowledgementStartedAt,
  };
}

function validRevisions(): ChannexCertificationBookingRevisionEvidence[] {
  return [
    validRevision({
      lifecycle: "NEW",
      persistenceCompletedAt: "2026-08-09T01:00:01.000Z",
      acknowledgementStartedAt: "2026-08-09T01:00:02.000Z",
    }),
    validRevision({
      lifecycle: "MODIFICATION",
      persistenceCompletedAt: "2026-08-09T01:01:01.000Z",
      acknowledgementStartedAt: "2026-08-09T01:01:02.000Z",
    }),
    validRevision({
      lifecycle: "CANCELLATION",
      persistenceCompletedAt: "2026-08-09T01:02:01.000Z",
      acknowledgementStartedAt: "2026-08-09T01:02:02.000Z",
    }),
  ];
}

function certify(revisions: ChannexCertificationBookingRevisionEvidence[]) {
  return certifyChannexBookingReceivingScenario({
    pinGoPropertyId: CHANNEX_CERTIFICATION_V1_MANIFEST.propertyId,
    channexPropertyId:
      CHANNEX_CERTIFICATION_V1_MANIFEST.channexPropertyId,
    revisions,
  });
}

test("#11 local contract passes only for complete NEW/MOD/CANCEL evidence", () => {
  const result = certify(validRevisions().reverse());

  assert.deepEqual(result, {
    status: "LOCAL_CONTRACT_PASS",
    bookingId: "certification-booking-001",
    pinGoReservationId: "certification-reservation-001",
    revisionIds: [
      REJECTED_CERTIFICATION_REVISION_IDS.NEW,
      REJECTED_CERTIFICATION_REVISION_IDS.MODIFICATION,
      REJECTED_CERTIFICATION_REVISION_IDS.CANCELLATION,
    ],
    lifecycles: ["NEW", "MODIFICATION", "CANCELLATION"],
    bookingFindEvents: 0,
    duplicateReservations: 0,
    persistenceBeforeAcknowledgement: true,
    webhookDeliverySuccess: true,
  });
});

test("#11 aborts when any lifecycle revision is missing", () => {
  assert.throws(
    () => certify(validRevisions().slice(0, 2)),
    /CHANNEX_CERTIFICATION_BOOKING_REVISION_COUNT_MISMATCH:2/
  );
});

test("#11 aborts on the exact Booking Find classification from rejection", () => {
  const revisions = validRevisions();
  revisions[0]!.ingestMechanism = "booking_received_via_booking_find";

  assert.throws(
    () => certify(revisions),
    /CHANNEX_BOOKING_FIND_FORBIDDEN:BOOKING_RECEIVED_VIA_BOOKING_FIND/
  );
});

test("#11 aborts when Channex webhook notes.success is not true", () => {
  const revisions = validRevisions();
  revisions[1]!.webhookDeliveryNotesSuccess = false;

  assert.throws(
    () => certify(revisions),
    /CHANNEX_CERTIFICATION_BOOKING_WEBHOOK_DELIVERY_FAILED:MODIFICATION/
  );
});

test("#11 aborts when ACK starts before persistence completes", () => {
  const revisions = validRevisions();
  revisions[2]!.acknowledgementStartedAt =
    revisions[2]!.persistenceCompletedAt;

  assert.throws(
    () => certify(revisions),
    /CHANNEX_CERTIFICATION_BOOKING_ACK_BEFORE_PERSISTENCE:CANCELLATION/
  );
});

test("#11 aborts when modification creates another Pin&Go reservation", () => {
  const revisions = validRevisions();
  revisions[1]!.pinGoReservationId = "duplicate-reservation-002";

  assert.throws(
    () => certify(revisions),
    /CHANNEX_CERTIFICATION_PIN_GO_RESERVATION_MISMATCH/
  );
});

test("#11 aborts when more than one reservation exists for the booking", () => {
  const revisions = validRevisions();
  revisions[0]!.reservationCountForBooking = 2;

  assert.throws(
    () => certify(revisions),
    /CHANNEX_CERTIFICATION_BOOKING_RESERVATION_COUNT_MISMATCH:NEW:2/
  );
});

test("#11 aborts when any revision leaves the frozen property", () => {
  const revisions = validRevisions();
  revisions[2]!.channexPropertyId = "wrong-channex-property";

  assert.throws(
    () => certify(revisions),
    /CHANNEX_CERTIFICATION_BOOKING_CHANNEX_PROPERTY_MISMATCH:CANCELLATION/
  );
});

test("#11 aborts when ACK did not succeed", () => {
  const revisions = validRevisions();
  revisions[0]!.acknowledgementStatus = "FAILED";

  assert.throws(
    () => certify(revisions),
    /CHANNEX_CERTIFICATION_BOOKING_ACK_FAILED:NEW/
  );
});

test("#11 aborts unless cancellation leaves the reservation cancelled", () => {
  const revisions = validRevisions();
  revisions[2]!.reservationStatus = "ACTIVE";

  assert.throws(
    () => certify(revisions),
    /CHANNEX_CERTIFICATION_BOOKING_STATUS_MISMATCH:CANCELLATION/
  );
});
