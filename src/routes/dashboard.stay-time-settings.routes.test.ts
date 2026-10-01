import assert from "node:assert/strict";
import test from "node:test";
import type { AddressInfo } from "node:net";
import express from "express";
import { buildDashboardStayTimeSettingsRouter } from "./dashboard.stay-time-settings.routes.js";
import { defaultStayTimeSettings, parseStayTimeSettingsUpdate } from "../pin-ai/actions/stay-time-settings.js";
import type { StayTimeSettingsDb } from "../services/property-stay-time-settings.service.js";

function memory() {
  const row = { id: "property-a", organizationId: "org-a", status: "ACTIVE", timezone: "America/Puerto_Rico",
    checkInTime: "15:00", checkOutTime: "11:00", stayTimeSettings: null as unknown, stayTimeSettingsRevision: 0 };
  const writes: unknown[] = [];
  let beforeWrite = () => {};
  const db = { property: {
    async findFirst({ where }: any) {
      return where.id === row.id && where.organizationId === row.organizationId && where.status === row.status ? structuredClone(row) : null;
    },
    async updateMany({ where, data }: any) {
      beforeWrite();
      if (Object.entries(where).some(([key, value]) => row[key as keyof typeof row] !== value)) return { count: 0 };
      writes.push(data);
      row.stayTimeSettings = structuredClone(data.stayTimeSettings);
      row.stayTimeSettingsRevision += data.stayTimeSettingsRevision.increment;
      return { count: 1 };
    },
  } } as unknown as StayTimeSettingsDb;
  return { db, row, writes, beforeWrite: (fn: () => void) => { beforeWrite = fn; } };
}
async function harness(t: test.TestContext, role: string | null = "ORG_ADMIN", orgId = "org-a") {
  const previous = process.env.CI;
  process.env.CI = "true";
  const state = memory();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (role !== null) (req as any).user = { id: "host-a", orgId, role };
    next();
  });
  app.use(buildDashboardStayTimeSettingsRouter(state.db));
  const server = await new Promise<ReturnType<typeof app.listen>>(resolve => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    if (previous === undefined) delete process.env.CI; else process.env.CI = previous;
  });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/dashboard/properties/property-a/stay-time-settings`;
  return { ...state, get: () => fetch(url), put: (body: unknown) => fetch(url, {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }) };
}
function body() {
  const settings = defaultStayTimeSettings();
  return { expectedRevision: 0, settings: { ...settings,
    lateCheckout: { ...settings.lateCheckout, enabled: true, fee: { mode: "PER_HOUR", amountMinor: 2500, currency: "USD" } },
  } };
}

test("GET returns independent disabled defaults without a database write", async t => {
  const app = await harness(t);
  const response = await app.get();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const result = await response.json();
  assert.equal(result.revision, 0);
  assert.deepEqual(result.settings, defaultStayTimeSettings());
  assert.equal(result.executionAvailable, false);
  assert.equal(app.writes.length, 0);
});
test("PUT persists independent rules and increments revision; GET round-trips", async t => {
  const app = await harness(t);
  const response = await app.put(body());
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.revision, 1);
  assert.deepEqual(result.settings, body().settings);
  assert.deepEqual((await (await app.get()).json()).settings, body().settings);
  assert.deepEqual(Object.keys(app.writes[0] as object).sort(), ["stayTimeSettings", "stayTimeSettingsRevision"]);
});
for (const [role, expected] of [[null, 401], ["STAFF", 403], ["", 403]] as const) {
  test(`read/write rejects unauthorized role ${role}`, async t => {
    const app = await harness(t, role);
    assert.equal((await app.get()).status, expected);
    assert.equal((await app.put(body())).status, expected);
    assert.equal(app.writes.length, 0);
  });
}
test("admin in another tenant cannot read or write", async t => {
  const app = await harness(t, "PLATFORM_ADMIN", "org-b");
  assert.equal((await app.get()).status, 404);
  assert.equal((await app.put(body())).status, 404);
  assert.equal(app.writes.length, 0);
});
test("inactive property cannot be configured", async t => {
  const app = await harness(t);
  app.row.status = "INACTIVE";
  assert.equal((await app.get()).status, 404);
  assert.equal((await app.put(body())).status, 404);
});
test("two writers at one revision produce one winner and one conflict", async t => {
  const app = await harness(t);
  const responses = await Promise.all([app.put(body()), app.put(body())]);
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 409]);
  assert.equal(app.row.stayTimeSettingsRevision, 1);
  assert.equal(app.writes.length, 1);
});
test("concurrent standard checkout change prevents save of stale limits", async t => {
  const app = await harness(t);
  app.beforeWrite(() => { app.row.checkOutTime = "16:00"; });
  assert.equal((await app.put(body())).status, 409);
  assert.equal(app.writes.length, 0);
});
test("invalid limits, fees and extra fields never persist", async t => {
  const app = await harness(t);
  const input = body();
  const invalid = [
    { ...input, organizationId: "org-b" }, { ...input, expectedRevision: "0" },
    { ...input, settings: { ...input.settings, lateCheckout: { ...input.settings.lateCheckout, limitLocalTime: "10:00" } } },
    { ...input, settings: { ...input.settings, lateCheckout: { ...input.settings.lateCheckout, limitLocalTime: "24:00" } } },
    { ...input, settings: { ...input.settings, lateCheckout: { ...input.settings.lateCheckout, enabled: "true" } } },
    ...[-1, 1.5, 100_000_000].map(amountMinor => ({ ...input, settings: { ...input.settings,
      lateCheckout: { ...input.settings.lateCheckout, fee: { ...input.settings.lateCheckout.fee, amountMinor } },
    } })),
  ];
  for (const value of invalid) assert.equal((await app.put(value)).status, 400);
  assert.equal(app.writes.length, 0);
});
test("can disable a rule after standard property hours change", async t => {
  const app = await harness(t);
  app.row.checkOutTime = "17:00";
  assert.equal((await app.put({ expectedRevision: 0, settings: defaultStayTimeSettings() })).status, 200);
});
test("enabled service requires a valid timezone; disabling remains possible", async t => {
  const app = await harness(t);
  app.row.timezone = "Not/A_Timezone";
  const response = await app.put(body());
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error, "STAY_TIME_PROPERTY_TIMEZONE_REQUIRED");
  assert.equal(app.writes.length, 0);
  assert.equal((await app.put({ expectedRevision: 0, settings: defaultStayTimeSettings() })).status, 200);
});
test("corrupt stored settings fail explicitly instead of silently authorizing defaults", async t => {
  const app = await harness(t);
  app.row.stayTimeSettings = { enabled: true };
  assert.equal((await app.get()).status, 409);
  assert.equal(app.writes.length, 0);
});
test("strict settings parser rejects unsupported currency, paid zero and free charges", () => {
  const input = body();
  for (const fee of [
    { mode: "FREE", amountMinor: 100, currency: "USD" },
    { mode: "FIXED", amountMinor: 0, currency: "USD" },
    { mode: "FIXED", amountMinor: 100, currency: "EUR" },
  ]) assert.throws(() => parseStayTimeSettingsUpdate({ ...input,
    settings: { ...input.settings, lateCheckout: { ...input.settings.lateCheckout, fee } },
  }), /STAY_TIME_SETTINGS_INVALID/);
});
