import assert from "node:assert/strict";
import test from "node:test";
import { Router } from "express";
import { requireAuth } from "../middleware/requireAuth";
import { buildDashboardCalendarOverridesRouter } from "./dashboard.calendar-overrides.route";
import { registerCalendarOverrideRemoval } from "./dashboard.calendar-overrides-removal.route";

type Row = { date: Date; minimumNights: number | null; maximumNights: number | null; source: string; propertyId: string };
const day = "2026-11-10";
const nextDay = "2026-11-11";
const row = (date = day, minimumNights: number | null = 4, maximumNights: number | null = 7, propertyId = "property-1"): Row => ({
  date: new Date(`${date}T00:00:00.000Z`), minimumNights, maximumNights, propertyId, source: "MANUAL",
});

function harness(options: {
  rows?: Row[]; minimumNights?: number; maximumNights?: number | null;
  distributed?: boolean; status?: string; failOutbox?: boolean; serializationFailure?: boolean;
} = {}) {
  let rows = structuredClone(options.rows ?? [row()]);
  let outbox: any[] = [];
  const writes: any[] = [];
  const propertyQueries: any[] = [];
  let transactions = 0;
  let isolation: unknown;
  const tx = {
    property: { findFirst: async (args: any) => {
      propertyQueries.push(args);
      return args.where.id === "property-1" && args.where.organizationId === "org-1" && (options.status ?? "ACTIVE") === args.where.status
        ? { id: "property-1", minimumNights: options.minimumNights ?? 2, maximumNights: options.maximumNights === undefined ? 10 : options.maximumNights,
          distributionEnabled: options.distributed !== false, distributionStatus: options.distributed === false ? "INACTIVE" : "ACTIVE" }
        : null;
    } },
    propertyNightlyRestriction: {
      findMany: async (args: any) => rows.filter((item) => item.propertyId === args.where.propertyId && args.where.date.in.some((date: Date) => +date === +item.date)).sort((a, b) => +a.date - +b.date),
      update: async (args: any) => {
        writes.push({ kind: "update", ...args });
        const item = rows.find((value) => value.propertyId === args.where.propertyId_date.propertyId && +value.date === +args.where.propertyId_date.date)!;
        Object.assign(item, args.data);
        return item;
      },
      delete: async (args: any) => {
        writes.push({ kind: "delete", ...args });
        const index = rows.findIndex((value) => value.propertyId === args.where.propertyId_date.propertyId && +value.date === +args.where.propertyId_date.date);
        assert.ok(index >= 0);
        return rows.splice(index, 1)[0];
      },
    },
    propertyNightlyRate: new Proxy({}, { get: () => { throw new Error("MUST_NOT_TOUCH_RATES"); } }),
    reservation: new Proxy({}, { get: () => { throw new Error("MUST_NOT_TOUCH_RESERVATIONS"); } }),
    propertyBlockedDate: new Proxy({}, { get: () => { throw new Error("MUST_NOT_TOUCH_BLOCKS"); } }),
    distributionOutboxEvent: { create: async (args: any) => {
      if (options.failOutbox) throw new Error("TEST_OUTBOX_FAILURE");
      outbox.push(args);
      return { id: `outbox-${outbox.length}`, ...args.data };
    } },
  };
  const db = { $transaction: async (callback: (value: any) => Promise<any>, settings: any) => {
    transactions += 1;
    isolation = settings?.isolationLevel;
    if (options.serializationFailure) throw Object.assign(new Error("retry"), { code: "P2034" });
    const before = structuredClone(rows);
    const previousOutbox = structuredClone(outbox);
    try { return await callback(tx); }
    catch (error) { rows = before; outbox = previousOutbox; throw error; }
  } } as any;
  const router = Router();
  registerCalendarOverrideRemoval(router, db);
  const layer = (router as any).stack.find((entry: any) => entry.route?.methods?.delete);
  assert.equal(layer.route.stack[0].handle, requireAuth);
  const handler = layer.route.stack.at(-1).handle;
  return {
    db, writes, propertyQueries,
    get rows() { return rows; }, get outbox() { return outbox; },
    get transactions() { return transactions; }, get isolation() { return isolation; },
    async invoke(body: unknown, orgId: unknown = "org-1", propertyId = "property-1") {
      let statusCode = 200;
      let response: any;
      const res = { status(code: number) { statusCode = code; return this; }, json(value: any) { response = value; return this; } };
      await handler({ user: { orgId }, params: { id: propertyId }, body }, res);
      return { statusCode, body: response };
    },
  };
}
const payload = (fields = ["minimumNights", "maximumNights"], dateKeys = [day]) => ({ fields, dateKeys });

test("DELETE is mounted alongside PUT and retains authentication", () => {
  const h = harness();
  const router = buildDashboardCalendarOverridesRouter(h.db);
  const layers = (router as any).stack.filter((entry: any) => entry.route?.path === "/api/dashboard/properties/:id/calendar-overrides");
  assert.equal(layers.filter((entry: any) => entry.route.methods.put).length, 1);
  const deletion = layers.find((entry: any) => entry.route.methods.delete);
  assert.ok(deletion);
  assert.equal(deletion.route.stack[0].handle, requireAuth);
});

test("removing minimum preserves maximum, rates, bookings, blocks, and emits only min fields", async () => {
  const h = harness();
  const result = await h.invoke(payload(["minimumNights"]));
  assert.equal(result.statusCode, 200);
  assert.equal(h.rows[0].minimumNights, null);
  assert.equal(h.rows[0].maximumNights, 7);
  assert.deepEqual(h.writes[0].data, { minimumNights: null });
  assert.equal(result.body.overrides[0].effectiveMinimumNights, 2);
  assert.equal(result.body.overrides[0].effectiveMaximumNights, 7);
  assert.deepEqual(h.outbox[0].data.changedFields, ["minStayArrival", "minStayThrough"]);
  assert.equal(h.outbox[0].data.trigger, "CALENDAR_RESTRICTION_REMOVE");
  assert.equal(h.isolation, "Serializable");
});

test("removing maximum preserves minimum and emits only maxStay", async () => {
  const h = harness({ maximumNights: null });
  const result = await h.invoke(payload(["maximumNights"]));
  assert.equal(result.statusCode, 200);
  assert.equal(h.rows[0].minimumNights, 4);
  assert.equal(h.rows[0].maximumNights, null);
  assert.deepEqual(h.writes[0].data, { maximumNights: null });
  assert.deepEqual(h.outbox[0].data.changedFields, ["maxStay"]);
  assert.equal(result.body.overrides[0].effectiveMaximumNights, null);
});

test("removing both deletes the empty override and restores property defaults", async () => {
  const h = harness();
  const result = await h.invoke(payload());
  assert.equal(result.statusCode, 200);
  assert.equal(h.rows.length, 0);
  assert.equal(h.writes[0].kind, "delete");
  assert.equal(result.body.affectedDates, 1);
  assert.equal(result.body.overrides[0].effectiveMinimumNights, 2);
  assert.equal(result.body.overrides[0].effectiveMaximumNights, 10);
  assert.deepEqual(h.outbox[0].data.changedFields, ["minStayArrival", "minStayThrough", "maxStay"]);
});

test("the last remaining restriction is removed without an empty row", async () => {
  const h = harness({ rows: [row(day, 4, null)] });
  await h.invoke(payload(["minimumNights"]));
  assert.equal(h.rows.length, 0);
  assert.deepEqual(h.outbox[0].data.changedFields, ["minStayArrival", "minStayThrough"]);
});

test("exact dates and property scope leave unselected dates and other properties unchanged", async () => {
  const h = harness({ rows: [row(), row(nextDay), row(day, 6, 9, "other-property")] });
  await h.invoke(payload());
  assert.deepEqual(h.rows, [row(nextDay), row(day, 6, 9, "other-property")]);
  assert.deepEqual(h.outbox[0].data.dateKeys, [day]);
});

test("multi-date deletion emits one exact outbox excluding dates without an override", async () => {
  const h = harness({ rows: [row(), row(nextDay)] });
  const result = await h.invoke(payload(undefined, [nextDay, "2026-11-12", day]));
  assert.equal(result.body.affectedDates, 2);
  assert.equal(h.outbox.length, 1);
  assert.deepEqual(h.outbox[0].data.dateKeys, [day, nextDay]);
});

test("retry is idempotent and does not enqueue redundant synchronization", async () => {
  const h = harness();
  await h.invoke(payload());
  const again = await h.invoke(payload());
  assert.equal(again.statusCode, 200);
  assert.equal(again.body.affectedDates, 0);
  assert.equal(again.body.syncQueued, false);
  assert.deepEqual(again.body.changedFields, []);
  assert.equal(h.outbox.length, 1);
});

test("an absent selected field is a no-op and preserves the other limit", async () => {
  const h = harness({ rows: [row(day, null, 7)] });
  const result = await h.invoke(payload(["minimumNights"]));
  assert.equal(result.body.affectedDates, 0);
  assert.equal(h.writes.length, 0);
  assert.equal(h.outbox.length, 0);
  assert.equal(h.rows[0].maximumNights, 7);
});

test("an inactive distribution is not queued", async () => {
  const h = harness({ distributed: false });
  const result = await h.invoke(payload());
  assert.equal(result.body.affectedDates, 1);
  assert.equal(result.body.syncQueued, false);
  assert.equal(h.outbox.length, 0);
});

for (const [name, options, fields] of [
  ["minimum fallback", { rows: [row(day, 1, 1)], minimumNights: 2 }, ["minimumNights"]],
  ["maximum fallback", { rows: [row(day, 4, 7)], maximumNights: 2 }, ["maximumNights"]],
] as const) {
  test(`rejects ${name} when the remaining pair would be invalid`, async () => {
    const h = harness(options);
    const result = await h.invoke(payload([...fields]));
    assert.equal(result.statusCode, 409);
    assert.match(result.body.error, /maximum lower than the minimum/);
    assert.equal(h.writes.length, 0);
    assert.equal(h.outbox.length, 0);
  });
}

test("all dates are validated before the first mutation", async () => {
  const h = harness({ rows: [row(), row(nextDay, 1, 1)] });
  const result = await h.invoke(payload(["minimumNights"], [day, nextDay]));
  assert.equal(result.statusCode, 409);
  assert.equal(h.writes.length, 0);
});

test("outbox failure rolls back removal in the same transaction", async () => {
  const h = harness({ failOutbox: true });
  const result = await h.invoke(payload());
  assert.equal(result.statusCode, 500);
  assert.deepEqual(h.rows, [row()]);
  assert.equal(h.outbox.length, 0);
});

test("serialization conflict returns a retryable response rather than success", async () => {
  const h = harness({ serializationFailure: true });
  const result = await h.invoke(payload());
  assert.equal(result.statusCode, 409);
  assert.match(result.body.error, /concurrently/);
  assert.equal(h.writes.length, 0);
});

test("missing organization fails closed before querying or mutating", async () => {
  const h = harness();
  const result = await h.invoke(payload(), null);
  assert.equal(result.statusCode, 403);
  assert.equal(h.transactions, 0);
});

for (const [name, org, property] of [["other tenant", "org-2", "property-1"], ["other property", "org-1", "property-2"]]) {
  test(`rejects ${name}`, async () => {
    const h = harness();
    const result = await h.invoke(payload(), org, property);
    assert.equal(result.statusCode, 404);
    assert.deepEqual(h.propertyQueries[0].where, { id: property, organizationId: org, status: "ACTIVE" });
    assert.equal(h.writes.length, 0);
  });
}

test("archived property cannot be modified", async () => {
  const h = harness({ status: "ARCHIVED" });
  assert.equal((await h.invoke(payload())).statusCode, 404);
});

test("non-manual restrictions cannot be removed by the manual control", async () => {
  const h = harness({ rows: [{ ...row(), source: "AUTOMATIC" }] });
  assert.equal((await h.invoke(payload())).statusCode, 409);
  assert.equal(h.writes.length, 0);
});

const invalid: [string, unknown][] = [
  ["empty dates", payload(undefined, [])], ["duplicate dates", payload(undefined, [day, day])],
  ["impossible date", payload(undefined, ["2026-02-30"])], ["non-date", payload(undefined, ["tomorrow"])],
  ["empty fields", payload([])], ["duplicate fields", payload(["minimumNights", "minimumNights"])],
  ["rate field", payload(["rate"])], ["unexpected body key", { ...payload(), rate: 200 }],
  ["null body", null], ["numeric date", { fields: ["minimumNights"], dateKeys: [123] }],
  ["oversized span", payload(undefined, [day, "2029-11-10"])],
  ["oversized batch", payload(undefined, Array(501).fill(day))],
];
for (const [name, body] of invalid) {
  test(`rejects ${name} before persistence`, async () => {
    const h = harness();
    assert.equal((await h.invoke(body)).statusCode, 400);
    assert.equal(h.transactions, 0);
    assert.equal(h.writes.length, 0);
  });
}
