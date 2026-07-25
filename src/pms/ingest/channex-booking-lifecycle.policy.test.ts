import assert from "node:assert/strict";
import test from "node:test";
import type { ChannexBookingRevision } from "../adapters/types";
import {
  classifyChannexRevisionLifecycle,
  isChannexCancellationRejected,
  isChannexRevisionOlderOrSame,
  parseChannexInsertedAt,
  sortChannexRevisionsOldestFirst,
} from "./channex-booking-lifecycle.policy";

function revision(args: {
  revisionId: string;
  insertedAt: string;
}): ChannexBookingRevision {
  return {
    identity: {
      revisionId: args.revisionId,
      bookingId: "booking-001",
      propertyId: "property-001",
      insertedAt: args.insertedAt,
    },
    reservation: {
      provider: "CHANNEX",
      externalReservationId: "booking-001",
      externalListingId: "room-type-001",
      status: "CONFIRMED",
      checkIn: "2026-08-01",
      checkOut: "2026-08-03",
    },
    raw: {},
  };
}

test("invalid inserted_at is rejected", () => {
  assert.throws(
    () => parseChannexInsertedAt("not-a-date"),
    /CHANNEX_REVISION_INVALID_INSERTED_AT/
  );
});

test("active-stay cancellation rejection is detected", () => {
  assert.equal(
    isChannexCancellationRejected({
      incomingStatus: "CANCELLED",
      lastIngestError: "CANCEL_REJECTED_ACTIVE_STAY",
    }),
    true
  );

  assert.equal(
    isChannexCancellationRejected({
      incomingStatus: "CONFIRMED",
      lastIngestError: "CANCEL_REJECTED_ACTIVE_STAY",
    }),
    false
  );
});

test("chronology guard treats equal timestamps as already processed", () => {
  const insertedAt = new Date("2026-07-24T12:00:00.000Z");

  assert.equal(
    isChannexRevisionOlderOrSame({
      incomingInsertedAt: insertedAt,
      currentExternalUpdatedAt: new Date("2026-07-24T12:00:00.000Z"),
    }),
    true
  );
});

test("rejected cancellation always blocks ACK path", () => {
  assert.equal(
    classifyChannexRevisionLifecycle({
      incomingStatus: "CANCELLED",
      incomingInsertedAt: new Date("2026-07-24T13:00:00.000Z"),
      currentExternalUpdatedAt: new Date("2026-07-24T12:00:00.000Z"),
      lastIngestError: "CANCEL_REJECTED_ACTIVE_STAY",
      existingPersistenceAuditStatus: "SUCCESS",
    }),
    "REJECT_CANCELLATION"
  );
});

test("ACK retry preserves prior persistence success", () => {
  assert.equal(
    classifyChannexRevisionLifecycle({
      incomingStatus: "CONFIRMED",
      incomingInsertedAt: new Date("2026-07-24T12:00:00.000Z"),
      currentExternalUpdatedAt: new Date("2026-07-24T12:00:00.000Z"),
      lastIngestError: null,
      existingPersistenceAuditStatus: "SUCCESS",
    }),
    "PRESERVE_PERSISTED_SUCCESS"
  );
});

test("older revision without prior success is marked superseded", () => {
  assert.equal(
    classifyChannexRevisionLifecycle({
      incomingStatus: "CONFIRMED",
      incomingInsertedAt: new Date("2026-07-24T11:00:00.000Z"),
      currentExternalUpdatedAt: new Date("2026-07-24T12:00:00.000Z"),
      lastIngestError: null,
      existingPersistenceAuditStatus: null,
    }),
    "MARK_SUPERSEDED"
  );
});

test("newer revision is ingested", () => {
  assert.equal(
    classifyChannexRevisionLifecycle({
      incomingStatus: "CONFIRMED",
      incomingInsertedAt: new Date("2026-07-24T13:00:00.000Z"),
      currentExternalUpdatedAt: new Date("2026-07-24T12:00:00.000Z"),
      lastIngestError: null,
      existingPersistenceAuditStatus: "SUCCESS",
    }),
    "INGEST"
  );
});

test("revisions are sorted oldest-first with deterministic tie breaking", () => {
  const sorted = sortChannexRevisionsOldestFirst([
    revision({
      revisionId: "revision-b",
      insertedAt: "2026-07-24T12:00:00.000Z",
    }),
    revision({
      revisionId: "revision-c",
      insertedAt: "2026-07-24T13:00:00.000Z",
    }),
    revision({
      revisionId: "revision-a",
      insertedAt: "2026-07-24T12:00:00.000Z",
    }),
  ]);

  assert.deepEqual(
    sorted.map((item) => item.identity.revisionId),
    ["revision-a", "revision-b", "revision-c"]
  );
});
