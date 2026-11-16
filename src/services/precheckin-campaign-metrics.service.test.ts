import assert from "node:assert/strict";
import test from "node:test";
import { Prisma } from "@prisma/client";
import { getPrecheckinCampaignMetrics } from "./precheckin-campaign-metrics.service.js";

test("query is tenant scoped, excludes tests/unpaid and uses booking creation window", async () => {
  let query: any;
  const db = { reservation: { groupBy: async (input: any) => { query = input; return []; } } } as any;
  const result = await getPrecheckinCampaignMetrics(db, "org-a", new Date("2026-11-16T16:00:00Z"));
  assert.deepEqual(query.where.property, { organizationId: "org-a", isTestProperty: false });
  assert.equal(query.where.source, "DIRECT_BOOKING");
  assert.equal(query.where.externalProvider, "PIN_GO_DIRECT");
  assert.deepEqual(query.where.externalRaw, { path: ["bookingAttribution", "campaign"], equals: "precheckin_return_stay" });
  assert.deepEqual(query.where.amountCollected, { gt: 0 });
  assert.equal(query.where.createdAt.gte.toISOString(), "2026-10-17T16:00:00.000Z");
  assert.equal(query.where.createdAt.lt.toISOString(), result.to);
  assert.equal(result.bookings, 0); assert.deepEqual(result.currencies, []);
  await assert.rejects(getPrecheckinCampaignMetrics(db, ""), /ORGANIZATION_REQUIRED/);
});
test("counts cancellations without hiding collected/refunded amounts, never mixes currencies", async () => {
  const group = (currency: string, status: string, count: number, collected: string, refunded: string) => ({
    currency, status, _count: { _all: count }, _sum: { amountCollected: new Prisma.Decimal(collected), amountRefunded: new Prisma.Decimal(refunded) },
  });
  const db = { reservation: { groupBy: async () => [group("usd", "ACTIVE", 2, "100.10", "0.10"),
    group("USD", "CANCELLED", 1, "40.25", "40.25"), group("eur", "ACTIVE", 1, "80.00", "10.00")] } } as any;
  const result = await getPrecheckinCampaignMetrics(db, "org-a");
  assert.equal(result.bookings, 4); assert.equal(result.cancelled, 1);
  assert.deepEqual(result.currencies, [
    { currency: "EUR", bookings: 1, cancelled: 0, collected: "80.00", refunded: "10.00", retained: "70.00" },
    { currency: "USD", bookings: 3, cancelled: 1, collected: "140.35", refunded: "40.35", retained: "100.00" },
  ]);
});
