import assert from "node:assert/strict";
import test from "node:test";

import type { ChannexAriCoalescingPlan } from "./channex-ari-coalescing.policy";
import type { ChannexAriDeliveryMapping } from "./channex-ari-delivery.service";
import {
  CHANNEX_ARI_FULL_SYNC_DAYS,
  addUtcDays,
} from "./channex-ari-lifecycle.policy";
import { readChannexAriSnapshot } from "./channex-ari-snapshot.service";

const SNAPSHOT_AT = new Date("2026-07-29T12:00:00.000Z");

function plan(
  overrides: Partial<ChannexAriCoalescingPlan> = {}
): ChannexAriCoalescingPlan {
  return {
    organizationId: "org-1",
    propertyId: "property-1",
    provider: "CHANNEX",
    messageKind: "AVAILABILITY",
    syncMode: "INCREMENTAL",
    scope: "EXACT_DATES",
    dateFrom: "2026-08-01",
    dateToExclusive: "2026-08-04",
    dateKeys: ["2026-08-01", "2026-08-03"],
    correlationId: "correlation-1",
    correlationIds: ["correlation-1"],
    mergedEventIds: ["event-1"],
    snapshotAt: SNAPSHOT_AT,
    ...overrides,
  };
}

function mapping(
  overrides: Partial<ChannexAriDeliveryMapping> = {}
): ChannexAriDeliveryMapping {
  return {
    connectionId: "connection-1",
    listingId: "listing-1",
    connectionProvider: "CHANNEX",
    connectionOrganizationId: "org-1",
    propertyOrganizationId: "org-1",
    propertyId: "property-1",
    externalRoomTypeId: "room-type-1",
    channexPropertyId: "channex-property-1",
    channexRatePlanId: "rate-plan-1",
    ...overrides,
  };
}

function property(overrides: Record<string, unknown> = {}) {
  return {
    id: "property-1",
    organizationId: "org-1",
    status: "ACTIVE",
    distributionEnabled: true,
    distributionStatus: "ACTIVE",
    timezone: "America/Puerto_Rico",
    minimumNights: 2,
    maximumNights: 14,
    ...overrides,
  };
}

function createDb(input: {
  property?: any;
  reservations?: any[];
  blockedDates?: any[];
} = {}) {
  const calls: Array<{ model: string; args: any }> = [];

  return {
    db: {
      property: {
        findFirst: async (args: any) => {
          calls.push({ model: "property", args });
          return input.property === undefined ? property() : input.property;
        },
      },
      reservation: {
        findMany: async (args: any) => {
          calls.push({ model: "reservation", args });
          return input.reservations ?? [];
        },
      },
      propertyBlockedDate: {
        findMany: async (args: any) => {
          calls.push({ model: "blockedDate", args });
          return input.blockedDates ?? [];
        },
      },
    } as any,
    calls,
  };
}

function pricingResult(
  values: Array<{ date: string; rate: string | number }>
) {
  return {
    nightlyRates: values.map((value) => ({
      ...value,
      reason: "BASE_RATE",
      appliedRules: ["BASE_RATE"],
      pricingBreakdown: [],
    })),
  } as any;
}

test("reads a timezone-aware availability snapshot from reservations and blocks", async () => {
  const mock = createDb({
    reservations: [
      {
        checkIn: new Date("2026-08-02T03:00:00.000Z"),
        checkOut: new Date("2026-08-03T03:00:00.000Z"),
      },
    ],
    blockedDates: [
      {
        startDate: new Date("2026-08-03T04:00:00.000Z"),
        endDate: new Date("2026-08-04T04:00:00.000Z"),
      },
    ],
  });
  let pricingCalls = 0;

  const result = await readChannexAriSnapshot(mock.db, {
    plan: plan(),
    mapping: mapping(),
    calculatePricing: (async () => {
      pricingCalls += 1;
      return pricingResult([]);
    }) as any,
  });

  assert.equal(pricingCalls, 0);
  assert.equal(result.messageKind, "AVAILABILITY");
  assert.deepEqual(result.data.payload.values, [
    {
      property_id: "channex-property-1",
      room_type_id: "room-type-1",
      date: "2026-08-01",
      availability: 0,
    },
    {
      property_id: "channex-property-1",
      room_type_id: "room-type-1",
      date: "2026-08-03",
      availability: 0,
    },
  ]);
  assert.deepEqual(result.data.unavailableDateKeys, [
    "2026-08-01",
    "2026-08-03",
  ]);
  assert.match(result.data.payloadHash, /^[a-f0-9]{64}$/);
  assert.ok(result.data.payloadBytes > 0);
  assert.deepEqual(mock.calls.map((call) => call.model), [
    "property",
    "reservation",
    "blockedDate",
  ]);
  assert.deepEqual(mock.calls[1].args, {
    where: {
      propertyId: "property-1",
      status: "ACTIVE",
      checkIn: { lt: new Date("2026-08-05T00:00:00.000Z") },
      checkOut: { gt: new Date("2026-07-31T00:00:00.000Z") },
    },
    select: { checkIn: true, checkOut: true },
  });
});

test("serializes Revenue currency amounts as fixed two-decimal strings without unit conversion", async () => {
  const mock = createDb();
  const selectedPlan = plan({
    messageKind: "RATES_RESTRICTIONS",
    dateFrom: "2026-08-01",
    dateToExclusive: "2026-08-04",
    dateKeys: ["2026-08-01", "2026-08-03"],
  });
  const pricingCalls: any[] = [];

  const result = await readChannexAriSnapshot(mock.db, {
    plan: selectedPlan,
    mapping: mapping(),
    calculatePricing: (async (input: any) => {
      pricingCalls.push(input);
      return pricingResult([
        { date: "2026-08-01", rate: 159.99 },
        { date: "2026-08-02", rate: "172.4000" },
        { date: "2026-08-03", rate: 185 },
      ]);
    }) as any,
  });

  assert.deepEqual(pricingCalls, [
    {
      propertyId: "property-1",
      checkIn: new Date("2026-08-01T00:00:00.000Z"),
      checkOut: new Date("2026-08-04T00:00:00.000Z"),
    },
  ]);
  assert.equal(result.messageKind, "RATES_RESTRICTIONS");
  assert.deepEqual(result.data.payload.values, [
    {
      property_id: "channex-property-1",
      rate_plan_id: "rate-plan-1",
      date: "2026-08-01",
      rate: "159.99",
      min_stay_arrival: 2,
      min_stay_through: 2,
      max_stay: 14,
    },
    {
      property_id: "channex-property-1",
      rate_plan_id: "rate-plan-1",
      date: "2026-08-03",
      rate: "185.00",
      min_stay_arrival: 2,
      min_stay_through: 2,
      max_stay: 14,
    },
  ]);
  assert.deepEqual(mock.calls.map((call) => call.model), ["property"]);
});

test("expands a date-range plan and defaults max stay to zero", async () => {
  const mock = createDb({
    property: property({ minimumNights: 1, maximumNights: null }),
  });
  const selectedPlan = plan({
    messageKind: "RATES_RESTRICTIONS",
    scope: "DATE_RANGE",
    dateFrom: "2026-08-01",
    dateToExclusive: "2026-08-04",
    dateKeys: [],
  });

  const result = await readChannexAriSnapshot(mock.db, {
    plan: selectedPlan,
    mapping: mapping(),
    calculatePricing: (async () =>
      pricingResult([
        { date: "2026-08-03", rate: "130.00" },
        { date: "2026-08-01", rate: "110.00" },
        { date: "2026-08-02", rate: "120.00" },
      ])) as any,
  });

  assert.deepEqual(
    result.data.payload.values.map((value: any) => ({
      date: value.date,
      rate: value.rate,
      maxStay: value.max_stay,
    })),
    [
      { date: "2026-08-01", rate: "110.00", maxStay: 0 },
      { date: "2026-08-02", rate: "120.00", maxStay: 0 },
      { date: "2026-08-03", rate: "130.00", maxStay: 0 },
    ]
  );
});

test("expands exactly the certified 500-day full horizon", async () => {
  const mock = createDb({
    property: property({ minimumNights: 1, maximumNights: 30 }),
  });
  const from = "2026-08-01";
  const toExclusive = addUtcDays(from, CHANNEX_ARI_FULL_SYNC_DAYS);
  const selectedPlan = plan({
    messageKind: "RATES_RESTRICTIONS",
    syncMode: "FULL",
    scope: "FULL_HORIZON",
    dateFrom: from,
    dateToExclusive: toExclusive,
    dateKeys: [],
    correlationId: "full-sync-1",
    correlationIds: ["full-sync-1"],
  });
  const values = Array.from(
    { length: CHANNEX_ARI_FULL_SYNC_DAYS },
    (_, index) => ({
      date: addUtcDays(from, index),
      rate: `${100 + index}.00`,
    })
  );

  const result = await readChannexAriSnapshot(mock.db, {
    plan: selectedPlan,
    mapping: mapping(),
    calculatePricing: (async () => pricingResult(values)) as any,
  });

  assert.equal(result.data.payloadValueCount, CHANNEX_ARI_FULL_SYNC_DAYS);
  assert.equal(result.data.dateFrom, from);
  assert.equal(result.data.dateToExclusive, toExclusive);
  assert.equal(result.data.payload.values[0].date, from);
  assert.equal(
    result.data.payload.values[CHANNEX_ARI_FULL_SYNC_DAYS - 1].date,
    addUtcDays(from, CHANNEX_ARI_FULL_SYNC_DAYS - 1)
  );
});

test("rejects invalid plan and mapping alignment before database access", async () => {
  const scenarios: Array<{
    selectedPlan: ChannexAriCoalescingPlan;
    selectedMapping: ChannexAriDeliveryMapping;
    error: RegExp;
  }> = [
    {
      selectedPlan: plan(),
      selectedMapping: mapping({ propertyOrganizationId: "org-2" }),
      error: /CHANNEX_ARI_SNAPSHOT_ORGANIZATION_MISMATCH/,
    },
    {
      selectedPlan: plan(),
      selectedMapping: mapping({ propertyId: "property-2" }),
      error: /CHANNEX_ARI_SNAPSHOT_PROPERTY_MISMATCH/,
    },
    {
      selectedPlan: plan({ dateKeys: ["2026-08-03", "2026-08-01"] }),
      selectedMapping: mapping(),
      error: /CHANNEX_ARI_SNAPSHOT_DATE_KEYS_NOT_CANONICAL/,
    },
    {
      selectedPlan: plan({ dateToExclusive: "2026-08-05" }),
      selectedMapping: mapping(),
      error: /CHANNEX_ARI_SNAPSHOT_DATE_BOUNDS_MISMATCH/,
    },
    {
      selectedPlan: plan({ scope: "DATE_RANGE", dateKeys: ["2026-08-01"] }),
      selectedMapping: mapping(),
      error: /CHANNEX_ARI_SNAPSHOT_DATE_RANGE_KEYS_NOT_ALLOWED/,
    },
    {
      selectedPlan: plan({
        syncMode: "FULL",
        scope: "FULL_HORIZON",
        dateToExclusive: "2026-08-04",
        dateKeys: [],
      }),
      selectedMapping: mapping(),
      error: /CHANNEX_ARI_SNAPSHOT_FULL_PLAN_INVALID/,
    },
  ];

  for (const scenario of scenarios) {
    const mock = createDb();

    await assert.rejects(
      () =>
        readChannexAriSnapshot(mock.db, {
          plan: scenario.selectedPlan,
          mapping: scenario.selectedMapping,
        }),
      scenario.error
    );
    assert.equal(mock.calls.length, 0);
  }
});

test("rejects unavailable property states before reading source data", async () => {
  const scenarios: Array<{ value: any; error: RegExp }> = [
    { value: null, error: /CHANNEX_ARI_SNAPSHOT_PROPERTY_NOT_FOUND/ },
    {
      value: property({ status: "ARCHIVED" }),
      error: /CHANNEX_ARI_SNAPSHOT_PROPERTY_NOT_ACTIVE/,
    },
    {
      value: property({ distributionEnabled: false }),
      error: /CHANNEX_ARI_SNAPSHOT_DISTRIBUTION_NOT_ACTIVE/,
    },
    {
      value: property({ distributionStatus: "FAILED" }),
      error: /CHANNEX_ARI_SNAPSHOT_DISTRIBUTION_NOT_ACTIVE/,
    },
  ];

  for (const scenario of scenarios) {
    const mock = createDb({ property: scenario.value });

    await assert.rejects(
      () =>
        readChannexAriSnapshot(mock.db, {
          plan: plan(),
          mapping: mapping(),
        }),
      scenario.error
    );
    assert.deepEqual(mock.calls.map((call) => call.model), ["property"]);
  }
});

test("rejects invalid stay restrictions and malformed Revenue output", async () => {
  const ratePlan = plan({ messageKind: "RATES_RESTRICTIONS" });
  const scenarios: Array<{
    selectedProperty: any;
    pricing: any;
    error: RegExp;
  }> = [
    {
      selectedProperty: property({ minimumNights: 0 }),
      pricing: pricingResult([]),
      error: /CHANNEX_ARI_SNAPSHOT_MINIMUM_NIGHTS_INVALID/,
    },
    {
      selectedProperty: property({ maximumNights: -1 }),
      pricing: pricingResult([]),
      error: /CHANNEX_ARI_SNAPSHOT_MAXIMUM_NIGHTS_INVALID/,
    },
    {
      selectedProperty: property(),
      pricing: {},
      error: /CHANNEX_ARI_REVENUE_NIGHTLY_RATES_INVALID/,
    },
    {
      selectedProperty: property(),
      pricing: pricingResult([
        { date: "2026-08-01", rate: 0 },
        { date: "2026-08-03", rate: 100 },
      ]),
      error: /CHANNEX_ARI_REVENUE_RATE_INVALID:2026-08-01/,
    },
    {
      selectedProperty: property(),
      pricing: pricingResult([{ date: "2026-08-01", rate: 100 }]),
      error: /CHANNEX_ARI_REVENUE_DATE_MISSING:2026-08-03/,
    },
    {
      selectedProperty: property(),
      pricing: pricingResult([
        { date: "2026-08-01", rate: "100.00" },
        { date: "2026-08-01", rate: "101.00" },
        { date: "2026-08-03", rate: "120.00" },
      ]),
      error: /CHANNEX_ARI_REVENUE_DUPLICATE_DATE_CONFLICT:2026-08-01/,
    },
  ];

  for (const scenario of scenarios) {
    const mock = createDb({ property: scenario.selectedProperty });

    await assert.rejects(
      () =>
        readChannexAriSnapshot(mock.db, {
          plan: ratePlan,
          mapping: mapping(),
          calculatePricing: (async () => scenario.pricing) as any,
        }),
      scenario.error
    );
  }
});

test("does not mutate plan, mapping, source rows or expose unrelated data", async () => {
  const selectedPlan = plan({ messageKind: "RATES_RESTRICTIONS" });
  const selectedMapping = mapping();
  const selectedProperty = property({ apiKey: "must-not-be-returned" });
  const beforePlan = structuredClone(selectedPlan);
  const beforeMapping = structuredClone(selectedMapping);
  const beforeProperty = structuredClone(selectedProperty);
  const mock = createDb({ property: selectedProperty });

  const result = await readChannexAriSnapshot(mock.db, {
    plan: selectedPlan,
    mapping: selectedMapping,
    calculatePricing: (async () =>
      pricingResult([
        { date: "2026-08-01", rate: "100.00" },
        { date: "2026-08-03", rate: "120.00" },
      ])) as any,
  });

  assert.deepEqual(selectedPlan, beforePlan);
  assert.deepEqual(selectedMapping, beforeMapping);
  assert.deepEqual(selectedProperty, beforeProperty);
  assert.equal(JSON.stringify(result).includes("must-not-be-returned"), false);
});
