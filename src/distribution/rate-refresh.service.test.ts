import assert from "node:assert/strict";
import test from "node:test";
import { refreshPropertyRates, runRateRefreshCycle, type RateRefreshDb, type RateRefreshTx } from "./rate-refresh.service.js";

const now = new Date("2026-10-12T21:00:00Z");
const property = (id = "property-a") => ({ id, organizationId: "org-a", timezone: "America/Puerto_Rico",
  status: "ACTIVE", distributionEnabled: true, distributionStatus: "ACTIVE",
  baseNightlyRate: "100.00", minimumNightlyRate: null, maximumNightlyRate: null,
  dynamicPricingEnabled: true, seasonalPricingEnabled: false, holidayPricingEnabled: false,
  weekendMarkupPercent: "0", leadTimePricingEnabled: true, leadTimeLastMinuteDays: 3,
  leadTimeLastMinutePercent: "-10", occupancyPricingEnabled: true, occupancyLookaheadDays: 30,
  occupancyLowThresholdPercent: "40", occupancyLowAdjustmentPercent: "-5",
  occupancyHighThresholdPercent: "80", occupancyHighAdjustmentPercent: "10",
});
type Event = { id: string; organizationId: string; propertyId: string; messageKind: string;
  sourceEntityId: string; sourceEntityType: string; trigger: string; provider: string;
  changedFields: string[]; dateFrom: Date; dateToExclusive: Date; status: string; createdAt: Date };
type Query = { where: Record<string, unknown>; cursor?: { id: string }; take?: number };

function fixture(properties = [property()]) {
  const events: Event[] = [];
  let locked = true;
  let failRates = false;
  let mappingFailureProperty = "";
  let serializationFailures = 0;
  const reservations: Array<{ propertyId: string; status: string; checkIn: Date; checkOut: Date }> = [];
  const tx = {
    $queryRaw: async () => [{ locked }],
    property: {
      findFirst: async ({ where }: Query) => properties.find(p => p.id === where.id && p.organizationId === where.organizationId &&
        p.status === "ACTIVE" && p.distributionEnabled && p.distributionStatus === "ACTIVE") ?? null,
    },
    pmsConnection: { findUnique: async ({ where }: { where: { organizationId_provider: { organizationId: string } } }) => ({
      id: "connection-a", organizationId: where.organizationId_provider.organizationId, provider: "CHANNEX", status: "ACTIVE",
    }) },
    pmsListing: { findMany: async ({ where }: Query) => where.propertyId === mappingFailureProperty ? [] : [{
      id: "listing-a", connectionId: "connection-a", propertyId: where.propertyId,
      externalListingId: "room-a", metadata: { provider: "CHANNEX", channexPropertyId: "external-property-a", channexRatePlanId: "rate-a" },
    }] },
    reservation: { findMany: async ({ where }: Query) => reservations.filter(r => r.propertyId === where.propertyId && r.status === "ACTIVE" &&
      r.checkIn < (where.checkIn as { lt: Date }).lt && r.checkOut > (where.checkOut as { gt: Date }).gt) },
    distributionOutboxEvent: {
      findFirst: async ({ where }: Query) => [...events].reverse().find(e =>
        Object.entries(where).every(([k, v]) => e[k as keyof Event] === v)) ?? null,
      create: async ({ data }: { data: Event }) => {
        if (failRates && data.messageKind === "RATES_RESTRICTIONS") throw Error("TEST_RATE_WRITE_FAILED");
        const e = { ...data, id: `event-${events.length + 1}`, createdAt: now };
        events.push(e); return e;
      },
    },
  };
  const db = {
    property: { findMany: async (query: Query) => {
      const eligible = properties.filter(p => p.status === "ACTIVE" && p.distributionEnabled && p.distributionStatus === "ACTIVE");
      const start = query.cursor ? eligible.findIndex(p => p.id === query.cursor!.id) + 1 : 0;
      return eligible.slice(start, start + (query.take ?? 100));
    } },
    $transaction: async (work: (tx: RateRefreshTx) => Promise<unknown>, options: { isolationLevel: string }) => {
      assert.equal(options.isolationLevel, "Serializable");
      if (serializationFailures > 0) {
        serializationFailures--;
        throw Object.assign(new Error("TRANSACTION_ROLLED_BACK"), { code: "P2034" });
      }
      const length = events.length;
      try { return await work(tx as unknown as RateRefreshTx); }
      catch (error) { events.length = length; throw error; }
    },
  };
  return { tx: tx as unknown as RateRefreshTx, db: db as unknown as RateRefreshDb, events, reservations,
    lock: (value: boolean) => { locked = value; }, failRates: (value: boolean) => { failRates = value; },
    failMapping: (value: string) => { mappingFailureProperty = value; },
    serializeFailures: (value: number) => { serializationFailures = value; } };
}

test("bootstrap atomically enqueues availability and rates through the certified outbox", async () => {
  const f = fixture();
  assert.equal((await runRateRefreshCycle(f.db, now)).enqueued, 2);
  assert.deepEqual(f.events.map(e => [e.provider, e.status]), [["CHANNEX", "PENDING"], ["CHANNEX", "PENDING"]]);
  assert.deepEqual(f.events[1]!.changedFields, ["rate", "minStayArrival", "minStayThrough", "maxStay"]);
  assert.equal((await runRateRefreshCycle(f.db, now)).enqueued, 0);
});
test("persisted restart state prevents repeated sends; cancellation/reactivation cannot reuse an older snapshot", async () => {
  const f = fixture();
  await runRateRefreshCycle(f.db, now);
  f.reservations.push({ propertyId: "property-a", status: "ACTIVE",
    checkIn: new Date("2026-10-13T20:00Z"), checkOut: new Date("2026-10-15T15:00Z") });
  assert.equal((await runRateRefreshCycle(f.db, now)).enqueued, 1);
  assert.deepEqual(f.events.at(-1)!.changedFields, ["rate"]);
  f.reservations[0]!.status = "CANCELLED";
  assert.equal((await runRateRefreshCycle(f.db, now)).enqueued, 1);
  f.reservations[0]!.status = "ACTIVE";
  assert.equal((await runRateRefreshCycle(f.db, now)).enqueued, 1);
  assert.equal((await runRateRefreshCycle(f.db, now)).enqueued, 0);
});
test("half an enqueue rolls back; the next cycle retries the complete operation", async () => {
  const f = fixture(); f.failRates(true);
  assert.equal((await runRateRefreshCycle(f.db, now)).failed, 1);
  assert.equal(f.events.length, 0);
  f.failRates(false);
  assert.equal((await runRateRefreshCycle(f.db, now)).enqueued, 2);
});
test("concurrent property lease skips every write", async () => {
  const f = fixture(); f.lock(false);
  const result = await runRateRefreshCycle(f.db, now);
  assert.equal(result.busy, 1); assert.equal(f.events.length, 0);
});
test("tenant mismatch and disabled distribution cannot enqueue", async () => {
  const f = fixture();
  assert.equal((await refreshPropertyRates(f.tx, { propertyId: "property-a", organizationId: "org-b" }, now)).status, "INELIGIBLE");
  const disabled = property(); disabled.distributionEnabled = false;
  assert.equal((await runRateRefreshCycle(fixture([disabled]).db, now)).checked, 0);
  assert.equal(f.events.length, 0);
});
test("a broken mapping does not starve the next property", async () => {
  const f = fixture([property("property-a"), property("property-b")]); f.failMapping("property-a");
  const result = await runRateRefreshCycle(f.db, now);
  assert.equal(result.failed, 1); assert.equal(result.enqueued, 2);
  assert.deepEqual([...new Set(f.events.map(e => e.propertyId))], ["property-b"]);
});
test("keyset pagination visits properties beyond the first 100", async () => {
  const f = fixture(Array.from({ length: 101 }, (_, i) => property(`property-${String(i).padStart(3, "0")}`)));
  const result = await runRateRefreshCycle(f.db, now);
  assert.equal(result.checked, 101); assert.equal(result.enqueued, 202); assert.equal(result.failed, 0);
});

test("known rolled-back serialization conflicts retry within a bounded limit", async () => {
  const f = fixture(); f.serializeFailures(2);
  assert.equal((await runRateRefreshCycle(f.db, now)).enqueued, 2);
  assert.equal(f.events.length, 2);
  const exhausted = fixture(); exhausted.serializeFailures(3);
  assert.equal((await runRateRefreshCycle(exhausted.db, now)).failed, 1);
  assert.equal(exhausted.events.length, 0);
});
