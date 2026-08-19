import assert from "node:assert/strict";
import test from "node:test";
import { buildChannexCertificationEvidence } from "../../services/channex-certification-evidence.policy";
import {
  certifyCollectedChannexBookingEvidence,
  type ChannexBookingLifecycleEvidence,
} from "./channex-certification-booking-evidence.policy";
import type { ChannexCertificationBookingLifecycle } from "./channex-certification-booking-receiving.policy";
import { CHANNEX_CERTIFICATION_V1_MANIFEST } from "./channex-certification-v1.fixture";

const REVISION_IDS = {
  NEW: "640268f5-9d5c-471e-93bc-53ddd93dabd0",
  MODIFICATION: "cbbeb9f0-6923-4139-8b48-4077e96143f9",
  CANCELLATION: "e3b6545e-edba-4148-93ec-d18de02eaf5e",
} as const;

function collectedEvidence(args: {
  lifecycle: ChannexCertificationBookingLifecycle;
  minute: string;
  reservationId?: string;
  eventStatus?: string;
}) {
  const status = args.lifecycle === "CANCELLATION" ? "CANCELLED" : "ACTIVE";

  return buildChannexCertificationEvidence({
    revisionId: REVISION_IDS[args.lifecycle],
    ingestMechanism: "BOOKING_REVISION_FEED",
    bookingId: "booking-001",
    bookingReference: "OTA-001",
    channexPropertyId:
      CHANNEX_CERTIFICATION_V1_MANIFEST.channexPropertyId,
    insertedAt: `2026-08-09T01:${args.minute}:00.000Z`,
    propertyId: CHANNEX_CERTIFICATION_V1_MANIFEST.propertyId,
    persistence: {
      status: "SUCCESS",
      reason: "CHANNEX_REVISION_PERSISTED",
      startedAt: `2026-08-09T01:${args.minute}:00.000Z`,
      completedAt: `2026-08-09T01:${args.minute}:01.000Z`,
    },
    acknowledgement: {
      status: "SUCCESS",
      reason: "CHANNEX_REVISION_ACKNOWLEDGED",
      startedAt: `2026-08-09T01:${args.minute}:02.000Z`,
      completedAt: `2026-08-09T01:${args.minute}:03.000Z`,
    },
    event: {
      eventType: "booking",
      status: args.eventStatus ?? "PROCESSED",
      attempts: 1,
      lastErrorCode: null,
      receivedAt: `2026-08-09T01:${args.minute}:00.000Z`,
      processedAt: `2026-08-09T01:${args.minute}:03.000Z`,
      updatedAt: `2026-08-09T01:${args.minute}:03.000Z`,
    },
    reservation: {
      reservationId: args.reservationId ?? "reservation-001",
      reservationNumber: "PG-2026-000100",
      status,
      externalProvider: "CHANNEX",
      externalId: "booking-001",
      externalUpdatedAt: `2026-08-09T01:${args.minute}:00.000Z`,
      lastIngestErrorCode: null,
      checkIn: "2026-11-01T20:00:00.000Z",
      checkOut: "2026-11-03T15:00:00.000Z",
      paymentState: "PAID",
      createdAt: "2026-08-09T01:00:00.000Z",
      updatedAt: `2026-08-09T01:${args.minute}:01.000Z`,
      reservationCountForBooking: 1,
    },
    missionControl: {
      persistenceStatus: "PERSISTED",
      acknowledgementStatus: "SENT",
      eventStatus: args.eventStatus ?? "PROCESSED",
      nextAutomaticAction: "NONE",
      recoverable: false,
      hostActionRequired: false,
    },
  });
}

function validLifecycleEvidence(): ChannexBookingLifecycleEvidence[] {
  return [
    {
      lifecycle: "NEW",
      collected: collectedEvidence({ lifecycle: "NEW", minute: "00" }),
      webhookDelivery: { httpStatus: 200, notesSuccess: true },
    },
    {
      lifecycle: "MODIFICATION",
      collected: collectedEvidence({
        lifecycle: "MODIFICATION",
        minute: "01",
      }),
      webhookDelivery: { httpStatus: 200, notesSuccess: true },
    },
    {
      lifecycle: "CANCELLATION",
      collected: collectedEvidence({
        lifecycle: "CANCELLATION",
        minute: "02",
      }),
      webhookDelivery: { httpStatus: 200, notesSuccess: true },
    },
  ];
}

test("aggregates three collected revision PASS results into #11 local pass", () => {
  const result = certifyCollectedChannexBookingEvidence({
    manifest: CHANNEX_CERTIFICATION_V1_MANIFEST,
    revisions: validLifecycleEvidence(),
  });

  assert.equal(result.status, "LOCAL_CONTRACT_PASS");
  assert.equal(result.bookingFindEvents, 0);
  assert.equal(result.duplicateReservations, 0);
  assert.equal(result.persistenceBeforeAcknowledgement, true);
  assert.equal(result.webhookDeliverySuccess, true);
});

test("rejects an individual revision whose collected evidence is incomplete", () => {
  const revisions = validLifecycleEvidence();
  revisions[1] = {
    lifecycle: "MODIFICATION",
    collected: collectedEvidence({
      lifecycle: "MODIFICATION",
      minute: "01",
      eventStatus: "FAILED",
    }),
    webhookDelivery: { httpStatus: 200, notesSuccess: true },
  };

  assert.throws(
    () =>
      certifyCollectedChannexBookingEvidence({
        manifest: CHANNEX_CERTIFICATION_V1_MANIFEST,
        revisions,
      }),
    /CHANNEX_CERTIFICATION_BOOKING_EVIDENCE_NOT_PASS:MODIFICATION:FAIL_INCOMPLETE/
  );
});

test("rejects a failed Channex webhook delivery", () => {
  const revisions = validLifecycleEvidence();
  revisions[0]!.webhookDelivery.notesSuccess = false;

  assert.throws(
    () =>
      certifyCollectedChannexBookingEvidence({
        manifest: CHANNEX_CERTIFICATION_V1_MANIFEST,
        revisions,
      }),
    /CHANNEX_CERTIFICATION_BOOKING_WEBHOOK_DELIVERY_FAILED:NEW/
  );
});

test("rejects a different Pin&Go reservation identity", () => {
  const revisions = validLifecycleEvidence();
  revisions[2] = {
    lifecycle: "CANCELLATION",
    collected: collectedEvidence({
      lifecycle: "CANCELLATION",
      minute: "02",
      reservationId: "reservation-duplicate-002",
    }),
    webhookDelivery: { httpStatus: 200, notesSuccess: true },
  };

  assert.throws(
    () =>
      certifyCollectedChannexBookingEvidence({
        manifest: CHANNEX_CERTIFICATION_V1_MANIFEST,
        revisions,
      }),
    /CHANNEX_CERTIFICATION_PIN_GO_RESERVATION_MISMATCH/
  );
});
