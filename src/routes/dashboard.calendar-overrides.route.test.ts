import assert from "node:assert/strict";
import test from "node:test";

import { buildDashboardCalendarOverridesRouter } from "./dashboard.calendar-overrides.route";

const PROPERTY_ID = "property-1";
const ORGANIZATION_ID = "org-1";

function inclusiveDateKeys(from: string, to: string): string[] {
  const keys: string[] = [];
  const cursor = new Date(`${from}T00:00:00.000Z`);
  const end = new Date(`${to}T00:00:00.000Z`);

  while (cursor <= end) {
    keys.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return keys;
}

function createHarness(input?: {
  minimumNights?: number;
  maximumNights?: number | null;
}) {
  const outboxCreates: any[] = [];
  const rateUpserts: any[] = [];
  const restrictionUpserts: any[] = [];
  let transactionCalls = 0;

  const tx = {
    propertyNightlyRestriction: {
      findMany: async () => [],
      upsert: async (args: any) => {
        restrictionUpserts.push(args);
        return {
          minimumNights: args.update.minimumNights ?? args.create.minimumNights,
          maximumNights: args.update.maximumNights ?? args.create.maximumNights,
        };
      },
    },
    propertyNightlyRate: {
      upsert: async (args: any) => {
        rateUpserts.push(args);
        return { rate: args.update.rate ?? args.create.rate };
      },
    },
    distributionOutboxEvent: {
      create: async (args: any) => {
        outboxCreates.push(args);
        return { id: `outbox-${outboxCreates.length}`, ...args.data };
      },
    },
  };

  const prisma = {
    property: {
      findFirst: async () => ({
        id: PROPERTY_ID,
        distributionEnabled: true,
        distributionStatus: "ACTIVE",
        minimumNightlyRate: null,
        maximumNightlyRate: null,
        minimumNights: input?.minimumNights ?? 1,
        maximumNights: input?.maximumNights ?? null,
      }),
    },
    $transaction: async (callback: (transaction: any) => Promise<any>) => {
      transactionCalls += 1;
      return callback(tx);
    },
  } as any;

  const router = buildDashboardCalendarOverridesRouter(prisma);
  const layer = (router as any).stack.find(
    (entry: any) => entry.route?.path === "/api/dashboard/properties/:id/calendar-overrides"
  );
  const handler = layer?.route?.stack?.at(-1)?.handle;

  assert.equal(typeof handler, "function");

  async function invoke(overrides: any[]) {
    let statusCode = 200;
    let body: any;

    const req = {
      user: { orgId: ORGANIZATION_ID },
      params: { id: PROPERTY_ID },
      body: { overrides },
    } as any;
    const res = {
      status(code: number) {
        statusCode = code;
        return this;
      },
      json(payload: any) {
        body = payload;
        return this;
      },
    } as any;

    await handler(req, res);
    return { statusCode, body };
  }

  return {
    invoke,
    outboxCreates,
    rateUpserts,
    restrictionUpserts,
    get transactionCalls() {
      return transactionCalls;
    },
  };
}

test("certification #5 persists one min-stay override and emits only min stay fields", async () => {
  const harness = createHarness({ minimumNights: 1 });
  const result = await harness.invoke([
    {
      date: "2026-11-23",
      minimumNights: 3,
      reason: "CHANNEX_CERTIFICATION_5",
    },
  ]);

  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.body.changedFields, ["minStayArrival", "minStayThrough"]);
  assert.equal(harness.transactionCalls, 1);
  assert.equal(harness.rateUpserts.length, 0);
  assert.equal(harness.restrictionUpserts.length, 1);
  assert.equal(harness.restrictionUpserts[0].create.minimumNights, 3);
  assert.equal(harness.restrictionUpserts[0].create.maximumNights, null);
  assert.equal(harness.outboxCreates.length, 1);
  assert.deepEqual(harness.outboxCreates[0].data.changedFields, [
    "minStayArrival",
    "minStayThrough",
  ]);
  assert.deepEqual(harness.outboxCreates[0].data.dateKeys, ["2026-11-23"]);
  assert.equal(harness.outboxCreates[0].data.trigger, "CALENDAR_OVERRIDE_UPDATE");
});

test("certification #7 persists min/max across Nov 1-10 and emits one exact outbox", async () => {
  const dateKeys = inclusiveDateKeys("2026-11-01", "2026-11-10");
  const harness = createHarness({ minimumNights: 1 });
  const result = await harness.invoke(
    dateKeys.map((date) => ({
      date,
      minimumNights: 1,
      maximumNights: 4,
      reason: "CHANNEX_CERTIFICATION_7",
    }))
  );

  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.body.changedFields, [
    "minStayArrival",
    "minStayThrough",
    "maxStay",
  ]);
  assert.equal(harness.rateUpserts.length, 0);
  assert.equal(harness.restrictionUpserts.length, 10);
  assert.equal(harness.outboxCreates.length, 1);
  assert.deepEqual(harness.outboxCreates[0].data.changedFields, [
    "minStayArrival",
    "minStayThrough",
    "maxStay",
  ]);
  assert.deepEqual(harness.outboxCreates[0].data.dateKeys, dateKeys);
});

test("certification #8 persists rate+min across Dec 1-May 1 and emits one exact outbox", async () => {
  const dateKeys = inclusiveDateKeys("2026-12-01", "2027-05-01");
  const harness = createHarness({ minimumNights: 1 });
  const result = await harness.invoke(
    dateKeys.map((date) => ({
      date,
      rate: 432,
      minimumNights: 2,
      reason: "CHANNEX_CERTIFICATION_8",
    }))
  );

  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.body.changedFields, [
    "rate",
    "minStayArrival",
    "minStayThrough",
  ]);
  assert.equal(harness.rateUpserts.length, dateKeys.length);
  assert.equal(harness.restrictionUpserts.length, dateKeys.length);
  assert.equal(harness.outboxCreates.length, 1);
  assert.deepEqual(harness.outboxCreates[0].data.changedFields, [
    "rate",
    "minStayArrival",
    "minStayThrough",
  ]);
  assert.deepEqual(harness.outboxCreates[0].data.dateKeys, dateKeys);
});

test("rejects heterogeneous field shapes before persistence or outbox creation", async () => {
  const harness = createHarness();
  const result = await harness.invoke([
    { date: "2026-11-01", rate: 241 },
    { date: "2026-11-02", minimumNights: 1 },
  ]);

  assert.equal(result.statusCode, 400);
  assert.equal(
    result.body.error,
    "All calendar overrides in one operation must include the same fields"
  );
  assert.equal(harness.transactionCalls, 0);
  assert.equal(harness.rateUpserts.length, 0);
  assert.equal(harness.restrictionUpserts.length, 0);
  assert.equal(harness.outboxCreates.length, 0);
});

test("rejects non-positive rates before persistence", async () => {
  const harness = createHarness();
  const result = await harness.invoke([{ date: "2026-11-22", rate: 0 }]);

  assert.equal(result.statusCode, 400);
  assert.equal(result.body.error, "Invalid rate for 2026-11-22");
  assert.equal(harness.transactionCalls, 0);
  assert.equal(harness.outboxCreates.length, 0);
});
