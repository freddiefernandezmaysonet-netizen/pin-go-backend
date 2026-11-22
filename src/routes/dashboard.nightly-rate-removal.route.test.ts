import assert from "node:assert/strict";
import test from "node:test";
import { Router } from "express";
import { requireAuth } from "../middleware/requireAuth";
import { registerNightlyRateRemoval } from "./dashboard.nightly-rate-removal.route";
import { buildDashboardCalendarOverridesRouter } from "./dashboard.calendar-overrides.route";

function harness({ failOutbox = false, dynamic = true, distributed = true, conflict = false, baseRate = 100 } = {}) {
  let rows = [{ propertyId: "p", date: new Date("2027-01-01Z") }, { propertyId: "p", date: new Date("2027-01-03Z") }, { propertyId: "other", date: new Date("2027-01-01Z") }];
  let events: any[] = [];
  const forbidden = new Proxy({}, { get() { throw Error("UNRELATED_WRITE"); } });
  const tx = {
    property: { findFirst: async ({ where }: any) => where.id === "p" && where.organizationId === "org" && where.status === "ACTIVE"
      ? { id: "p", baseNightlyRate: baseRate, dynamicPricingEnabled: dynamic, distributionEnabled: distributed, distributionStatus: "ACTIVE" } : null },
    propertyNightlyRate: {
      findMany: async ({ where }: any) => rows.filter(r => r.propertyId === where.propertyId && where.date.in.some((d: Date) => +d === +r.date)),
      deleteMany: async ({ where }: any) => { const before = rows.length; rows = rows.filter(r => !(r.propertyId === where.propertyId && where.date.in.some((d: Date) => +d === +r.date))); return { count: before - rows.length }; },
    },
    propertyNightlyRestriction: forbidden, reservation: forbidden, propertyBlockedDate: forbidden,
    distributionOutboxEvent: { create: async (args: any) => { if (failOutbox) throw Error("OUTBOX_FAILURE"); events.push(args.data); return { id: "event", ...args.data }; } },
  };
  const db: any = { $transaction: async (fn: any, settings: any) => {
    assert.equal(settings.isolationLevel, "Serializable");
    if (conflict) throw Object.assign(Error("conflict"), { code: "P2034" });
    const before = structuredClone(rows), beforeEvents = [...events];
    try { return await fn(tx); } catch (e) { rows = before; events = beforeEvents; throw e; }
  } };
  const router = Router(); registerNightlyRateRemoval(router, db);
  const layer = (router as any).stack.find((l: any) => l.route?.methods.delete);
  assert.equal(layer.route.stack[0].handle, requireAuth);
  const handler = layer.route.stack.at(-1).handle;
  return { db, get rows() { return rows; }, get events() { return events; }, async invoke(body: any, orgId = "org") {
    let status = 200, result: any;
    const res = { status(value: number) { status = value; return this; }, json(value: any) { result = value; return this; } };
    await handler({ user: { orgId }, params: { id: "p" }, body }, res);
    return { status, result };
  } };
}
const payload = { dateKeys: ["2027-01-01", "2027-01-02"] };
test("restoration is mounted, scoped to selected dates and queues only rate changes", async () => {
  const h = harness();
  const mounted = buildDashboardCalendarOverridesRouter(h.db) as any;
  assert.ok(mounted.stack.some((l: any) => l.route?.path.endsWith("/nightly-rates") && l.route.methods.delete));
  const r = await h.invoke(payload);
  assert.equal(r.status, 200); assert.equal(r.result.affectedDates, 1); assert.equal(r.result.dynamicPricingEnabled, true);
  assert.equal(h.rows.length, 2); assert.ok(h.rows.some(row => row.propertyId === "other"));
  assert.deepEqual(h.events[0].changedFields, ["rate"]); assert.equal(h.events[0].trigger, "NIGHTLY_RATE_REMOVE");
  const again = await h.invoke(payload); assert.equal(again.result.affectedDates, 0); assert.equal(h.events.length, 1);
});
test("base-only properties restore without enabling dynamic pricing or inactive distribution", async () => {
  const h = harness({ dynamic: false, distributed: false });
  const r = await h.invoke(payload); assert.equal(r.result.dynamicPricingEnabled, false); assert.equal(r.result.syncQueued, false); assert.equal(h.events.length, 0);
});
test("outbox failure rolls back removal; serializable conflict returns retryable response", async () => {
  const h = harness({ failOutbox: true }); assert.equal((await h.invoke(payload)).status, 500); assert.equal(h.rows.length, 3);
  assert.equal((await harness({ conflict: true }).invoke(payload)).status, 409);
});
test("rejects foreign organization and malformed, duplicate, empty or oversized date selections", async () => {
  const h = harness();
  assert.equal((await h.invoke(payload, "foreign")).status, 404);
  assert.equal((await h.invoke(payload, "")).status, 403);
  for (const body of [null, {}, { dateKeys: [] }, { dateKeys: ["2027-02-30"] }, { dateKeys: ["2027-01-01", "2027-01-01"] },
    { dateKeys: ["2027-01-01", "2029-01-01"] }, { dateKeys: ["2027-01-01"], fields: ["minimumNights"] },
    { dateKeys: Array(501).fill("2027-01-01") }]) assert.equal((await h.invoke(body)).status, 400);
  assert.equal(h.rows.length, 3); assert.equal(h.events.length, 0);
});

test("missing base price leaves manual rates intact", async () => {
  const h = harness({ baseRate: 0 }); assert.equal((await h.invoke(payload)).status, 409);
  assert.equal(h.rows.length, 3); assert.equal(h.events.length, 0);
});
