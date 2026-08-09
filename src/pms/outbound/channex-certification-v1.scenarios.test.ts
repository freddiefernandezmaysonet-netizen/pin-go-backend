import assert from "node:assert/strict";
import test from "node:test";

import { CHANNEX_CERTIFICATION_V1_MANIFEST } from "./channex-certification-v1.fixture";
import {
  certifyChannexBookingReceivingScenario,
} from "./channex-certification-booking-receiving.policy";
import { CHANNEX_CERTIFICATION_V1_SCENARIOS } from "./channex-certification-v1.scenarios";

function scenario(id: number) {
  const value = CHANNEX_CERTIFICATION_V1_SCENARIOS.find(
    (candidate) => candidate.id === id
  );
  assert.ok(value, `missing certification scenario #${id}`);
  return value;
}

test("declares scenarios #1 through #13 against one frozen mapping", () => {
  assert.deepEqual(
    CHANNEX_CERTIFICATION_V1_SCENARIOS.map((value) => value.id),
    Array.from({ length: 13 }, (_, index) => index + 1)
  );

  for (const value of CHANNEX_CERTIFICATION_V1_SCENARIOS) {
    assert.strictEqual(value.manifest, CHANNEX_CERTIFICATION_V1_MANIFEST);
    assert.equal(value.executionMode, "LOCAL_CONTRACT_ONLY");
    assert.equal(value.realChannexCallsAllowed, false);
  }
});

test("#1 requires exactly two 500-day Full Sync calls", () => {
  assert.deepEqual(scenario(1).expected, {
    availabilityRequests: 1,
    restrictionsRequests: 1,
    availabilityEndpoint: "/api/v1/availability",
    restrictionsEndpoint: "/api/v1/restrictions",
    horizonDays: 500,
    syncMode: "FULL",
  });
});

test("#2 requires one single-date rate-only delta", () => {
  assert.deepEqual(scenario(2).expected, {
    endpoint: "/api/v1/restrictions",
    requestCount: 1,
    date: "2026-11-22",
    rateMinorUnits: 33300,
    requiredFields: ["rate"],
    forbiddenFields: [
      "min_stay_arrival",
      "min_stay_through",
      "max_stay",
      "stop_sell",
      "closed_to_arrival",
      "closed_to_departure",
    ],
    ratePlanId: CHANNEX_CERTIFICATION_V1_MANIFEST.channexRatePlanId,
  });
});

test("#3 and #6 are skipped only for the reasons Channex accepted", () => {
  assert.deepEqual(scenario(3).expected, {
    status: "SKIPPED",
    reason: "CHANNEX_EMAIL_ACCEPTED_SINGLE_RATE_PLAN_OMISSION",
  });
  assert.deepEqual(scenario(6).expected, {
    status: "SKIPPED",
    reason: "STOP_SELL_NOT_SUPPORTED",
  });
});

test("#4 uses the first official interval on the single rate plan", () => {
  assert.deepEqual(scenario(4).expected, {
    endpoint: "/api/v1/restrictions",
    requestCount: 1,
    dateFrom: "2026-11-01",
    dateTo: "2026-11-10",
    dateToInclusive: true,
    rateMinorUnits: 24100,
    requiredFields: ["rate"],
    ratePlanId: CHANNEX_CERTIFICATION_V1_MANIFEST.channexRatePlanId,
  });
});

test("#5 sends only the supported Min Stay fields", () => {
  assert.deepEqual(scenario(5).expected, {
    endpoint: "/api/v1/restrictions",
    requestCount: 1,
    date: "2026-11-23",
    minStay: 3,
    requiredFields: ["min_stay_arrival", "min_stay_through"],
    forbiddenFields: [
      "rate",
      "max_stay",
      "stop_sell",
      "closed_to_arrival",
      "closed_to_departure",
    ],
    ratePlanId: CHANNEX_CERTIFICATION_V1_MANIFEST.channexRatePlanId,
  });
});

test("#7 sends exactly Pin&Go's supported changed restrictions", () => {
  assert.deepEqual(scenario(7).expected, {
    endpoint: "/api/v1/restrictions",
    requestCount: 1,
    dateFrom: "2026-11-01",
    dateTo: "2026-11-10",
    dateToInclusive: true,
    minStay: 1,
    maxStay: 4,
    requiredFields: ["min_stay_arrival", "min_stay_through", "max_stay"],
    forbiddenFields: [
      "rate",
      "stop_sell",
      "closed_to_arrival",
      "closed_to_departure",
    ],
    ratePlanId: CHANNEX_CERTIFICATION_V1_MANIFEST.channexRatePlanId,
  });
});

test("#8 covers the official half-year interval in one request", () => {
  assert.deepEqual(scenario(8).expected, {
    endpoint: "/api/v1/restrictions",
    requestCount: 1,
    dateFrom: "2026-12-01",
    dateTo: "2027-05-01",
    dateToInclusive: true,
    rateMinorUnits: 43200,
    minStay: 2,
    requiredFields: ["rate", "min_stay_arrival", "min_stay_through"],
    ratePlanId: CHANNEX_CERTIFICATION_V1_MANIFEST.channexRatePlanId,
  });
});

test("#9 and #10 preserve single-unit availability and the frozen room type", () => {
  assert.deepEqual(scenario(9).expected, {
    endpoint: "/api/v1/availability",
    requestCount: 1,
    syntax: "DATE",
    date: "2026-11-21",
    availability: 1,
    roomTypeId: CHANNEX_CERTIFICATION_V1_MANIFEST.channexRoomTypeId,
  });
  assert.deepEqual(scenario(10).expected, {
    endpoint: "/api/v1/availability",
    requestCount: 1,
    syntax: "DATE_RANGE",
    dateFrom: "2026-11-10",
    dateTo: "2026-11-16",
    dateToInclusive: true,
    availability: 1,
    mergedSequences: true,
    roomTypeId: CHANNEX_CERTIFICATION_V1_MANIFEST.channexRoomTypeId,
  });
});

test("#11 requires revision ingestion, persistence before ACK and zero booking_find", () => {
  const bookingScenario = scenario(11) as any;

  assert.strictEqual(
    bookingScenario.localGate,
    certifyChannexBookingReceivingScenario
  );
  assert.deepEqual(bookingScenario.expected, {
    lifecycle: ["NEW", "MODIFICATION", "CANCELLATION"],
    rejectedCertificationRevisionIds: [
      "640268f5-9d5c-471e-93bc-53ddd93dabd0",
      "cbbeb9f0-6923-4139-8b48-4077e96143f9",
      "e3b6545e-edba-4148-93ec-d18de02eaf5e",
    ],
    permittedIngestMechanisms: [
      "BOOKING_REVISION_BY_ID",
      "BOOKING_REVISION_FEED",
    ],
    forbiddenIngestMechanisms: [
      "BOOKING_LIST",
      "BOOKING_LIST_POLLING",
      "BOOKING_FIND",
      "BOOKING_BY_ID",
      "BOOKING_RECEIVED_VIA_BOOKING_FIND",
      "MANUAL_PERSIST_AND_ACK",
    ],
    revisionEndpoints: [
      "/api/v1/booking_revisions/:id",
      "/api/v1/booking_revisions/feed",
    ],
    acknowledgeEndpoint: "/api/v1/booking_revisions/:id/ack",
    persistBeforeAck: true,
    sameReservationIdentity: true,
    duplicatesAllowed: false,
    webhookHttpStatusMin: 200,
    webhookHttpStatusMax: 299,
    webhookDeliveryNotesSuccessRequired: true,
    eventStatus: "PROCESSED",
    persistenceStatus: "SUCCESS",
    acknowledgementStatus: "SUCCESS",
    bookingFindEventsExpected: 0,
  });
});

test("#12 freezes the official per-property ARI limits", () => {
  assert.deepEqual(scenario(12).expected, {
    restrictionsPerMinute: 10,
    availabilityPerMinute: 10,
    ariTotalPerMinute: 20,
    queueRequired: true,
    batchingRequired: true,
    exponentialBackoffRequired: true,
    pauseAfterErrorMs: 60000,
  });
});

test("#13 requires change-only updates and forbids timer-based Full Sync", () => {
  assert.deepEqual(scenario(13).expected, {
    deltaUpdatesRequired: true,
    timerBasedFullSyncAllowed: false,
    fullSyncMinimumIntervalHours: 24,
  });
});
