import assert from "node:assert/strict";
import test from "node:test";
import {
  getHostCalendar,
  parseCalendarQuery,
} from "./host-calendar.service.js";
const query = { from: "2026-10-01", to: "2026-10-04", page: 1 };
function setup(overrides: Record<string, unknown> = {}) {
  const reads: any[] = [];
  const db: any = {
    property: {
      count: async (q: any) => {
        reads.push(q);
        return 1;
      },
      findMany: async (q: any) => {
        reads.push(q);
        return [
          {
            id: "p1",
            name: "Casa",
            timezone: "America/Puerto_Rico",
            publicPhotos: [],
            minimumNights: 2,
            maximumNights: null,
          },
        ];
      },
    },
    reservation: {
      findMany: async (q: any) => {
        reads.push(q);
        return [
          {
            id: "r1",
            reservationNumber: "PG-1",
            guestName: "Guest",
            checkIn: new Date("2026-10-02T01:00:00Z"),
            checkOut: new Date("2026-10-03T15:00:00Z"),
          },
        ];
      },
    },
    propertyBlockedDate: { findMany: async () => [] },
    propertyNightlyRestriction: {
      findMany: async () => [
        { date: new Date("2026-10-02"), minimumNights: 4, maximumNights: null },
      ],
    },
    ...overrides,
  };
  return { db, reads };
}
test("bounded ranges and pagination reject invalid requests", () => {
  for (const bad of [
    { from: "2026-02-30" },
    { to: "2026-12-01" },
    { to: query.from },
    { page: "1.5" },
    { propertyId: ["p1"] },
  ])
    assert.throws(() => parseCalendarQuery({ ...query, ...bad }));
  assert.deepEqual(
    parseCalendarQuery({ from: query.from, to: query.to }),
    query,
  );
});
test("tenant-scoped reads use property dates, exclusive checkout and effective restrictions", async () => {
  const { db, reads } = setup();
  const result = await getHostCalendar(
    db,
    async (input) => {
      assert.equal(input.includeAuditEntries, false);
      return { nightlyRates: [{ date: "2026-10-01", rate: 95 }] };
    },
    "org1",
    query,
  );
  assert.equal(reads[0].where.organizationId, "org1");
  assert.equal(reads[1].take, 10);
  assert.equal(reads[2].where.property.organizationId, "org1");
  assert.equal(reads[2].where.status, "ACTIVE");
  assert.deepEqual(
    result.items[0]?.days.map((d) => d.status),
    ["BOOKED", "BOOKED", "OPEN"],
  );
  assert.deepEqual(
    result.items[0]?.days.map((d) => d.minimumNights),
    [2, 4, 2],
  );
  assert.equal(result.items[0]?.days[2]?.rate, null);
});
test("unowned property stops before pricing or reservation reads", async () => {
  const { db } = setup({
    property: { count: async () => 0, findMany: async () => [] },
  });
  await assert.rejects(
    getHostCalendar(
      db,
      async () => {
        throw Error("must not run");
      },
      "org1",
      { ...query, propertyId: "other-tenant" },
    ),
    /PROPERTY_NOT_FOUND/,
  );
});
test("failed occupancy cannot display as open, failed pricing stays unknown", async () => {
  const { db } = setup({
    reservation: {
      findMany: async () => {
        throw Error("DB");
      },
    },
  });
  const failed = await getHostCalendar(
    db,
    async () => ({ nightlyRates: [] }),
    "org1",
    query,
  );
  assert.equal(failed.items[0]?.state, "UNAVAILABLE");
  assert.deepEqual(failed.items[0]?.days, []);
  const normal = setup();
  const noPrice = await getHostCalendar(
    normal.db,
    async () => {
      throw Error("PRICE");
    },
    "org1",
    query,
  );
  assert.equal(noPrice.items[0]?.state, "READY");
  assert.equal(noPrice.items[0]?.pricingUnavailable, true);
  assert.equal(noPrice.items[0]?.days[0]?.rate, null);
});
