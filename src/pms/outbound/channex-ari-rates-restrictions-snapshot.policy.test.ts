import assert from "node:assert/strict";
import test from "node:test";

import { addUtcDays } from "./channex-ari-lifecycle.policy";
import { buildChannexAriRatesRestrictionsSnapshot } from "./channex-ari-rates-restrictions-snapshot.policy";

function buildValues(
  from: string,
  count: number
): Array<{
  date: string;
  rate: string;
  minStayArrival: number;
  minStayThrough: number;
  maxStay: number;
}> {
  return Array.from({ length: count }, (_, index) => ({
    date: addUtcDays(from, index),
    rate: `${100 + index}.00`,
    minStayArrival: 1,
    minStayThrough: 1,
    maxStay: 0,
  }));
}

test("builds a canonical Rates & Restrictions-only payload", () => {
  const snapshot = buildChannexAriRatesRestrictionsSnapshot({
    channexPropertyId: " property-1 ",
    channexRatePlanId: " rate-plan-1 ",
    values: [
      {
        date: "2026-08-03",
        rate: "185.75",
        minStayArrival: 3,
        minStayThrough: 2,
        maxStay: 14,
      },
      {
        date: "2026-08-01",
        rate: 15999,
        minStayArrival: 2,
        minStayThrough: 2,
        maxStay: 0,
      },
      {
        date: "2026-08-02",
        rate: "172.40",
        minStayArrival: 2,
        minStayThrough: 3,
        maxStay: 10,
      },
    ],
  });

  assert.deepEqual(snapshot.payload, {
    values: [
      {
        property_id: "property-1",
        rate_plan_id: "rate-plan-1",
        date: "2026-08-01",
        rate: 15999,
        min_stay_arrival: 2,
        min_stay_through: 2,
        max_stay: 0,
      },
      {
        property_id: "property-1",
        rate_plan_id: "rate-plan-1",
        date: "2026-08-02",
        rate: "172.40",
        min_stay_arrival: 2,
        min_stay_through: 3,
        max_stay: 10,
      },
      {
        property_id: "property-1",
        rate_plan_id: "rate-plan-1",
        date: "2026-08-03",
        rate: "185.75",
        min_stay_arrival: 3,
        min_stay_through: 2,
        max_stay: 14,
      },
    ],
  });
  assert.equal(snapshot.payloadValueCount, 3);
  assert.equal(snapshot.dateFrom, "2026-08-01");
  assert.equal(snapshot.dateToExclusive, "2026-08-04");
  assert.ok(snapshot.payloadBytes > 0);
  assert.match(snapshot.payloadHash, /^[a-f0-9]{64}$/);

  for (const value of snapshot.payload.values) {
    assert.deepEqual(Object.keys(value), [
      "property_id",
      "rate_plan_id",
      "date",
      "rate",
      "min_stay_arrival",
      "min_stay_through",
      "max_stay",
    ]);
    assert.equal("availability" in value, false);
    assert.equal("available" in value, false);
    assert.equal("stop_sell" in value, false);
    assert.equal("closed_to_arrival" in value, false);
    assert.equal("closed_to_departure" in value, false);
  }
});

test("certification #2 emits a rate-only delta for one date and one rate plan", () => {
  const snapshot = buildChannexAriRatesRestrictionsSnapshot({
    channexPropertyId: "certification-property-1",
    channexRatePlanId: "certification-rate-plan-1",
    changedFields: ["rate"],
    values: [
      {
        date: "2026-11-01",
        rate: 15999,
        minStayArrival: 3,
        minStayThrough: 3,
        maxStay: 14,
      },
    ],
  } as any);

  assert.equal(snapshot.payload.values.length, 1);
  assert.deepEqual(snapshot.payload.values[0], {
    property_id: "certification-property-1",
    rate_plan_id: "certification-rate-plan-1",
    date: "2026-11-01",
    rate: 15999,
  });

  const value = snapshot.payload.values[0] as Record<string, unknown>;
  assert.equal("min_stay_arrival" in value, false);
  assert.equal("min_stay_through" in value, false);
  assert.equal("max_stay" in value, false);
  assert.equal("stop_sell" in value, false);
  assert.equal("closed_to_arrival" in value, false);
  assert.equal("closed_to_departure" in value, false);
});

test("certification #4 compacts the first official interval into one rate-only range", () => {
  const snapshot = buildChannexAriRatesRestrictionsSnapshot({
    channexPropertyId: "1d699e11-593c-4a3d-b66a-28741759e82f",
    channexRatePlanId: "daa6211c-bd9b-455f-b526-4136550b9a92",
    changedFields: ["rate"],
    values: Array.from({ length: 10 }, (_, index) => ({
      date: addUtcDays("2026-11-01", index),
      rate: 24100,
      minStayArrival: 1,
      minStayThrough: 1,
      maxStay: 0,
    })),
  });

  assert.deepEqual(snapshot.payload.values, [
    {
      property_id: "1d699e11-593c-4a3d-b66a-28741759e82f",
      rate_plan_id: "daa6211c-bd9b-455f-b526-4136550b9a92",
      date_from: "2026-11-01",
      date_to: "2026-11-10",
      rate: 24100,
    },
  ]);
  assert.equal(snapshot.payloadValueCount, 1);
});

test("certification #5 emits one single-date Min Stay-only update", () => {
  const snapshot = buildChannexAriRatesRestrictionsSnapshot({
    channexPropertyId: "1d699e11-593c-4a3d-b66a-28741759e82f",
    channexRatePlanId: "daa6211c-bd9b-455f-b526-4136550b9a92",
    changedFields: ["minStayArrival", "minStayThrough"],
    values: [
      {
        date: "2026-11-23",
        rate: 99999,
        minStayArrival: 3,
        minStayThrough: 3,
        maxStay: 14,
      },
    ],
  });

  assert.deepEqual(snapshot.payload.values, [
    {
      property_id: "1d699e11-593c-4a3d-b66a-28741759e82f",
      rate_plan_id: "daa6211c-bd9b-455f-b526-4136550b9a92",
      date: "2026-11-23",
      min_stay_arrival: 3,
      min_stay_through: 3,
    },
  ]);
  const value = snapshot.payload.values[0] as Record<string, unknown>;
  assert.equal("rate" in value, false);
  assert.equal("max_stay" in value, false);
  assert.equal("stop_sell" in value, false);
  assert.equal("closed_to_arrival" in value, false);
  assert.equal("closed_to_departure" in value, false);
  assert.equal(snapshot.payloadValueCount, 1);
});

test("certification #7 emits one range with exactly Pin&Go's supported restrictions", () => {
  const snapshot = buildChannexAriRatesRestrictionsSnapshot({
    channexPropertyId: "1d699e11-593c-4a3d-b66a-28741759e82f",
    channexRatePlanId: "daa6211c-bd9b-455f-b526-4136550b9a92",
    changedFields: ["minStayArrival", "minStayThrough", "maxStay"],
    values: Array.from({ length: 10 }, (_, index) => ({
      date: addUtcDays("2026-11-01", index),
      rate: 99999,
      minStayArrival: 1,
      minStayThrough: 1,
      maxStay: 4,
    })),
  });

  assert.deepEqual(snapshot.payload.values, [
    {
      property_id: "1d699e11-593c-4a3d-b66a-28741759e82f",
      rate_plan_id: "daa6211c-bd9b-455f-b526-4136550b9a92",
      date_from: "2026-11-01",
      date_to: "2026-11-10",
      min_stay_arrival: 1,
      min_stay_through: 1,
      max_stay: 4,
    },
  ]);
  const value = snapshot.payload.values[0] as Record<string, unknown>;
  assert.equal("rate" in value, false);
  assert.equal("stop_sell" in value, false);
  assert.equal("closed_to_arrival" in value, false);
  assert.equal("closed_to_departure" in value, false);
  assert.equal(snapshot.payloadValueCount, 1);
});

test("certification #8 emits one rate and Min Stay range for the official half-year interval", () => {
  const dates: string[] = [];

  for (
    let date = "2026-12-01";
    date <= "2027-05-01";
    date = addUtcDays(date, 1)
  ) {
    dates.push(date);
  }

  const snapshot = buildChannexAriRatesRestrictionsSnapshot({
    channexPropertyId: "1d699e11-593c-4a3d-b66a-28741759e82f",
    channexRatePlanId: "daa6211c-bd9b-455f-b526-4136550b9a92",
    changedFields: ["rate", "minStayArrival", "minStayThrough"],
    values: dates.map((date) => ({
      date,
      rate: 43200,
      minStayArrival: 2,
      minStayThrough: 2,
      maxStay: 99,
    })),
  });

  assert.deepEqual(snapshot.payload.values, [
    {
      property_id: "1d699e11-593c-4a3d-b66a-28741759e82f",
      rate_plan_id: "daa6211c-bd9b-455f-b526-4136550b9a92",
      date_from: "2026-12-01",
      date_to: "2027-05-01",
      rate: 43200,
      min_stay_arrival: 2,
      min_stay_through: 2,
    },
  ]);
  assert.equal("max_stay" in snapshot.payload.values[0], false);
  assert.equal(snapshot.payloadValueCount, 1);
  assert.equal(snapshot.dateFrom, "2026-12-01");
  assert.equal(snapshot.dateToExclusive, "2027-05-02");
});

test("preserves Revenue output without rounding or imposing a Distribution minimum", () => {
  const snapshot = buildChannexAriRatesRestrictionsSnapshot({
    channexPropertyId: "property-1",
    channexRatePlanId: "rate-plan-1",
    values: [
      {
        date: "2026-08-01",
        rate: "0.01",
        minStayArrival: 1,
        minStayThrough: 1,
        maxStay: 0,
      },
      {
        date: "2026-08-02",
        rate: 1,
        minStayArrival: 1,
        minStayThrough: 1,
        maxStay: 0,
      },
      {
        date: "2026-08-03",
        rate: "199.9900",
        minStayArrival: 1,
        minStayThrough: 1,
        maxStay: 0,
      },
    ],
  });

  assert.deepEqual(
    snapshot.payload.values.map((value) => value.rate),
    ["0.01", 1, "199.9900"]
  );
});

test("accepts max_stay zero as no configured maximum", () => {
  const snapshot = buildChannexAriRatesRestrictionsSnapshot({
    channexPropertyId: "property-1",
    channexRatePlanId: "rate-plan-1",
    values: [
      {
        date: "2026-08-01",
        rate: "150.00",
        minStayArrival: 4,
        minStayThrough: 5,
        maxStay: 0,
      },
    ],
  });

  assert.equal(snapshot.payload.values[0].max_stay, 0);
});

test("deduplicates identical dates and produces a stable hash", () => {
  const first = buildChannexAriRatesRestrictionsSnapshot({
    channexPropertyId: "property-1",
    channexRatePlanId: "rate-plan-1",
    values: [
      {
        date: "2026-08-02",
        rate: "175.00",
        minStayArrival: 2,
        minStayThrough: 2,
        maxStay: 10,
      },
      {
        date: "2026-08-01",
        rate: "150.00",
        minStayArrival: 1,
        minStayThrough: 1,
        maxStay: 0,
      },
      {
        date: "2026-08-02",
        rate: "175.00",
        minStayArrival: 2,
        minStayThrough: 2,
        maxStay: 10,
      },
    ],
  });

  const second = buildChannexAriRatesRestrictionsSnapshot({
    channexPropertyId: "property-1",
    channexRatePlanId: "rate-plan-1",
    values: [
      {
        date: "2026-08-01",
        rate: "150.00",
        minStayArrival: 1,
        minStayThrough: 1,
        maxStay: 0,
      },
      {
        date: "2026-08-02",
        rate: "175.00",
        minStayArrival: 2,
        minStayThrough: 2,
        maxStay: 10,
      },
    ],
  });

  assert.equal(first.payloadValueCount, 2);
  assert.deepEqual(first.payload, second.payload);
  assert.equal(first.payloadHash, second.payloadHash);
  assert.equal(first.payloadBytes, second.payloadBytes);
});

test("rejects conflicting values for the same date", () => {
  assert.throws(
    () =>
      buildChannexAriRatesRestrictionsSnapshot({
        channexPropertyId: "property-1",
        channexRatePlanId: "rate-plan-1",
        values: [
          {
            date: "2026-08-01",
            rate: "150.00",
            minStayArrival: 1,
            minStayThrough: 1,
            maxStay: 0,
          },
          {
            date: "2026-08-01",
            rate: "175.00",
            minStayArrival: 1,
            minStayThrough: 1,
            maxStay: 0,
          },
        ],
      }),
    /CHANNEX_ARI_DUPLICATE_DATE_CONFLICT:2026-08-01/
  );
});

test("rejects invalid rates instead of modifying them", () => {
  const invalidRates: unknown[] = [
    0,
    -1,
    10.5,
    Number.MAX_SAFE_INTEGER + 1,
    "0",
    "0.00",
    " 150.00",
    "150.00 ",
    "1e2",
    "-1.00",
    ".50",
    "150.",
  ];

  invalidRates.forEach((rate, index) => {
    assert.throws(
      () =>
        buildChannexAriRatesRestrictionsSnapshot({
          channexPropertyId: "property-1",
          channexRatePlanId: "rate-plan-1",
          values: [
            {
              date: "2026-08-01",
              rate: rate as any,
              minStayArrival: 1,
              minStayThrough: 1,
              maxStay: 0,
            },
          ],
        }),
      new RegExp(`CHANNEX_ARI_RATE_0_(?:INVALID|NOT_POSITIVE)`),
      `invalid rate at index ${index}`
    );
  });
});

test("rejects invalid stay restrictions", () => {
  assert.throws(
    () =>
      buildChannexAriRatesRestrictionsSnapshot({
        channexPropertyId: "property-1",
        channexRatePlanId: "rate-plan-1",
        values: [
          {
            date: "2026-08-01",
            rate: "150.00",
            minStayArrival: 0,
            minStayThrough: 1,
            maxStay: 0,
          },
        ],
      }),
    /CHANNEX_ARI_MIN_STAY_ARRIVAL_0_INVALID/
  );

  assert.throws(
    () =>
      buildChannexAriRatesRestrictionsSnapshot({
        channexPropertyId: "property-1",
        channexRatePlanId: "rate-plan-1",
        values: [
          {
            date: "2026-08-01",
            rate: "150.00",
            minStayArrival: 1,
            minStayThrough: 1.5,
            maxStay: 0,
          },
        ],
      }),
    /CHANNEX_ARI_MIN_STAY_THROUGH_0_INVALID/
  );

  assert.throws(
    () =>
      buildChannexAriRatesRestrictionsSnapshot({
        channexPropertyId: "property-1",
        channexRatePlanId: "rate-plan-1",
        values: [
          {
            date: "2026-08-01",
            rate: "150.00",
            minStayArrival: 1,
            minStayThrough: 1,
            maxStay: -1,
          },
        ],
      }),
    /CHANNEX_ARI_MAX_STAY_0_INVALID/
  );

  assert.throws(
    () =>
      buildChannexAriRatesRestrictionsSnapshot({
        channexPropertyId: "property-1",
        channexRatePlanId: "rate-plan-1",
        values: [
          {
            date: "2026-08-01",
            rate: "150.00",
            minStayArrival: 4,
            minStayThrough: 3,
            maxStay: 2,
          },
        ],
      }),
    /CHANNEX_ARI_MAX_STAY_0_BELOW_MINIMUM/
  );
});

test("accepts exactly 500 contiguous values", () => {
  const snapshot = buildChannexAriRatesRestrictionsSnapshot({
    channexPropertyId: "property-1",
    channexRatePlanId: "rate-plan-1",
    values: buildValues("2026-07-28", 500),
  });

  assert.equal(snapshot.payloadValueCount, 500);
  assert.equal(snapshot.dateFrom, "2026-07-28");
  assert.equal(snapshot.dateToExclusive, "2027-12-10");
});

test("rejects more than 500 values and sparse scopes wider than 500 days", () => {
  assert.throws(
    () =>
      buildChannexAriRatesRestrictionsSnapshot({
        channexPropertyId: "property-1",
        channexRatePlanId: "rate-plan-1",
        values: buildValues("2026-07-28", 501),
      }),
    /CHANNEX_ARI_RATES_RESTRICTIONS_VALUES_EXCEED_HORIZON/
  );

  assert.throws(
    () =>
      buildChannexAriRatesRestrictionsSnapshot({
        channexPropertyId: "property-1",
        channexRatePlanId: "rate-plan-1",
        values: [
          {
            date: "2026-07-28",
            rate: "150.00",
            minStayArrival: 1,
            minStayThrough: 1,
            maxStay: 0,
          },
          {
            date: "2027-12-10",
            rate: "175.00",
            minStayArrival: 1,
            minStayThrough: 1,
            maxStay: 0,
          },
        ],
      }),
    /CHANNEX_ARI_RATES_RESTRICTIONS_SCOPE_EXCEEDS_HORIZON/
  );
});

test("rejects missing mapping and empty values", () => {
  assert.throws(
    () =>
      buildChannexAriRatesRestrictionsSnapshot({
        channexPropertyId: " ",
        channexRatePlanId: "rate-plan-1",
        values: [
          {
            date: "2026-08-01",
            rate: "150.00",
            minStayArrival: 1,
            minStayThrough: 1,
            maxStay: 0,
          },
        ],
      }),
    /CHANNEX_ARI_CHANNEX_PROPERTY_ID_REQUIRED/
  );

  assert.throws(
    () =>
      buildChannexAriRatesRestrictionsSnapshot({
        channexPropertyId: "property-1",
        channexRatePlanId: " ",
        values: [
          {
            date: "2026-08-01",
            rate: "150.00",
            minStayArrival: 1,
            minStayThrough: 1,
            maxStay: 0,
          },
        ],
      }),
    /CHANNEX_ARI_CHANNEX_RATE_PLAN_ID_REQUIRED/
  );

  assert.throws(
    () =>
      buildChannexAriRatesRestrictionsSnapshot({
        channexPropertyId: "property-1",
        channexRatePlanId: "rate-plan-1",
        values: [],
      }),
    /CHANNEX_ARI_RATES_RESTRICTIONS_VALUES_REQUIRED/
  );
});
