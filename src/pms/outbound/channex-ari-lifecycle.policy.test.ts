import assert from "node:assert/strict";
import test from "node:test";

import {
  CHANNEX_ARI_FULL_SYNC_DAYS,
  CHANNEX_ARI_MAX_REQUEST_BYTES,
  CHANNEX_ARI_MIN_RATE_LIMIT_PAUSE_MS,
  addUtcDays,
  assertDateKey,
  assertPayloadWithinLimit,
  buildFullSyncRange,
  classifyChannexAriAttempt,
  countRangeDays,
  getRetryDelayMs,
  isFullSyncGuardActive,
  mergeDateRanges,
  normalizeDateKeys,
  validateV1Mapping,
} from "./channex-ari-lifecycle.policy";

test("builds an exact 500-day Full Sync range", () => {
  const range = buildFullSyncRange("2026-07-28");

  assert.deepEqual(range, {
    from: "2026-07-28",
    toExclusive: "2027-12-10",
  });
  assert.equal(countRangeDays(range), CHANNEX_ARI_FULL_SYNC_DAYS);
});

test("validates real date keys and rejects impossible dates", () => {
  assert.equal(assertDateKey("2028-02-29"), "2028-02-29");
  assert.throws(
    () => assertDateKey("2027-02-29"),
    /CHANNEX_ARI_INVALID_DATE/
  );
  assert.throws(
    () => assertDateKey("07\/28\/2026"),
    /CHANNEX_ARI_INVALID_DATE/
  );
});

test("adds UTC calendar days without local timezone drift", () => {
  assert.equal(addUtcDays("2026-12-31", 1), "2027-01-01");
  assert.equal(addUtcDays("2028-02-28", 1), "2028-02-29");
});

test("normalizes sparse date keys deterministically", () => {
  assert.deepEqual(
    normalizeDateKeys([
      "2026-08-03",
      "2026-08-01",
      "2026-08-03",
      "2026-08-02",
    ]),
    ["2026-08-01", "2026-08-02", "2026-08-03"]
  );
});

test("merges overlapping and adjacent date ranges", () => {
  assert.deepEqual(
    mergeDateRanges([
      { from: "2026-08-10", toExclusive: "2026-08-12" },
      { from: "2026-08-01", toExclusive: "2026-08-04" },
      { from: "2026-08-04", toExclusive: "2026-08-06" },
      { from: "2026-08-11", toExclusive: "2026-08-15" },
    ]),
    [
      { from: "2026-08-01", toExclusive: "2026-08-06" },
      { from: "2026-08-10", toExclusive: "2026-08-15" },
    ]
  );
});

test("rejects empty or reversed ranges", () => {
  assert.throws(
    () =>
      countRangeDays({
        from: "2026-08-01",
        toExclusive: "2026-08-01",
      }),
    /CHANNEX_ARI_INVALID_DATE_RANGE/
  );

  assert.throws(
    () =>
      mergeDateRanges([
        { from: "2026-08-02", toExclusive: "2026-08-01" },
      ]),
    /CHANNEX_ARI_INVALID_DATE_RANGE/
  );
});

test("classifies Channex ARI attempt outcomes", () => {
  assert.equal(
    classifyChannexAriAttempt({
      httpStatus: 200,
      taskId: "task-123",
      warningCount: 0,
    }),
    "SUCCESS"
  );

  assert.equal(
    classifyChannexAriAttempt({
      httpStatus: 200,
      taskId: null,
      warningCount: 0,
    }),
    "TERMINAL"
  );

  assert.equal(
    classifyChannexAriAttempt({
      httpStatus: 200,
      taskId: "task-123",
      warningCount: 1,
    }),
    "TERMINAL"
  );

  assert.equal(
    classifyChannexAriAttempt({ httpStatus: 429 }),
    "RETRYABLE"
  );
  assert.equal(
    classifyChannexAriAttempt({ httpStatus: 503 }),
    "RETRYABLE"
  );
  assert.equal(
    classifyChannexAriAttempt({ networkError: true }),
    "RETRYABLE"
  );
  assert.equal(
    classifyChannexAriAttempt({ timedOut: true }),
    "RETRYABLE"
  );
  assert.equal(
    classifyChannexAriAttempt({ httpStatus: 401 }),
    "TERMINAL"
  );
});

test("honors minimum pause, exponential backoff and Retry-After", () => {
  assert.equal(
    getRetryDelayMs({ attemptNumber: 1 }),
    CHANNEX_ARI_MIN_RATE_LIMIT_PAUSE_MS
  );
  assert.equal(
    getRetryDelayMs({ attemptNumber: 2 }),
    CHANNEX_ARI_MIN_RATE_LIMIT_PAUSE_MS * 2
  );
  assert.equal(
    getRetryDelayMs({ attemptNumber: 1, retryAfterMs: 180_000 }),
    180_000
  );
  assert.equal(
    getRetryDelayMs({ attemptNumber: 1, jitterMs: 9_000 }),
    CHANNEX_ARI_MIN_RATE_LIMIT_PAUSE_MS + 5_000
  );
  assert.throws(
    () => getRetryDelayMs({ attemptNumber: 0 }),
    /CHANNEX_ARI_INVALID_ATTEMPT_NUMBER/
  );
});

test("enforces the payload size limit", () => {
  const bytes = assertPayloadWithinLimit({ values: [{ date: "2026-08-01" }] });
  assert.ok(bytes > 0);

  assert.throws(
    () => assertPayloadWithinLimit("x".repeat(CHANNEX_ARI_MAX_REQUEST_BYTES + 1)),
    /CHANNEX_ARI_PAYLOAD_TOO_LARGE/
  );
});

test("enforces the 24-hour Full Sync guard", () => {
  const now = new Date("2026-07-28T12:00:00.000Z");

  assert.equal(
    isFullSyncGuardActive({
      now,
      lastFullSyncRequestedAt: new Date("2026-07-27T13:00:00.000Z"),
    }),
    true
  );

  assert.equal(
    isFullSyncGuardActive({
      now,
      lastFullSyncRequestedAt: new Date("2026-07-27T12:00:00.000Z"),
    }),
    false
  );
});

test("validates the V1 tenant and mapping contract", () => {
  assert.deepEqual(
    validateV1Mapping({
      connectionProvider: "CHANNEX",
      connectionOrganizationId: "org-1",
      propertyOrganizationId: "org-1",
      propertyId: "property-1",
      externalRoomTypeId: "room-type-1",
      channexPropertyId: "channex-property-1",
      channexRatePlanId: "rate-plan-1",
    }),
    { ok: true }
  );

  assert.deepEqual(
    validateV1Mapping({
      connectionProvider: "CHANNEX",
      connectionOrganizationId: "org-1",
      propertyOrganizationId: "org-2",
      propertyId: "property-1",
      externalRoomTypeId: "room-type-1",
      channexPropertyId: "channex-property-1",
      channexRatePlanId: "rate-plan-1",
    }),
    { ok: false, reason: "CHANNEX_ARI_TENANT_MISMATCH" }
  );

  assert.deepEqual(
    validateV1Mapping({
      connectionProvider: "CHANNEX",
      connectionOrganizationId: "org-1",
      propertyOrganizationId: "org-1",
      propertyId: "property-1",
      externalRoomTypeId: "room-type-1",
      channexPropertyId: "channex-property-1",
      channexRatePlanId: null,
    }),
    { ok: false, reason: "CHANNEX_ARI_RATE_PLAN_MAPPING_MISSING" }
  );
});
