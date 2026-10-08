import assert from "node:assert/strict";
import test from "node:test";
import { processOtaOperationalCommunications } from "./ota-operational-scan.service.js";
import type { deliverOtaOperationalCommunication } from "./ota-operational-guest.service.js";
import type { reconcileOtaOperationalDeliveryAttention } from "./ota-operational-attention.service.js";

const now = new Date("2026-10-03T18:00:00Z");
const env = {
  OTA_GUEST_EXTERNAL_MESSAGING_BLOCKED_PROVIDERS: "AIRBNB,BOOKING_COM",
} as NodeJS.ProcessEnv;

function row(id: string, source = "BookingCom") {
  return {
    id, source, externalProvider: "CHANNEX",
    propertyId: "prop", reservationNumber: "PG-SYNTHETIC", property: { organizationId: "org" },
    externalId: "11111111-1111-4111-8111-111111111111",
    // Crucial: an OTA communication must NOT depend on phone/email.
    guestEmail: null, guestPhone: null,
    checkIn: new Date(now.getTime() + 3600000),
    checkOut: new Date(now.getTime() + 24 * 3600000),
    guestAccessReleaseStatus: "RELEASED",
  };
}

function fixture(rows: ReturnType<typeof row>[]) {
  let queries = 0;
  const db: any = {
    reservation: {
      findMany: async ({ cursor, take }: any) => {
        queries++;
        const start = cursor ? rows.findIndex(r => r.id === cursor.id) + 1 : 0;
        return rows.slice(start, start + take);
      },
    },
  };
  const calls: string[] = [];
  const deliver = (async (_db: unknown, id: string, type: string) => {
    calls.push(id + ":" + type);
    return { ok: true, status: "SENT" };
  }) as typeof deliverOtaOperationalCommunication;
  const reconcile = (async () => "UNCHANGED") as typeof reconcileOtaOperationalDeliveryAttention;
  return { db, deliver, reconcile, calls, get queries() { return queries; } };
}

test("disabling OTA switch avoids all scans", async () => {
  const f = fixture([row("1")]);
  const result = await processOtaOperationalCommunications(f.db, {}, now, f.deliver, f.reconcile);
  assert.deepEqual(result, { candidates: 0, accepted: 0, blocked: 0 });
  assert.equal(f.queries, 0);
});

test("Airbnb and Booking.com without guest contact are scanned; Expedia remains untouched", async () => {
  const f = fixture([row("1", "BookingCom"), row("2", "Airbnb"), row("3", "Expedia")]);
  const result = await processOtaOperationalCommunications(f.db, env, now, f.deliver, f.reconcile);
  assert.deepEqual(result, { candidates: 2, accepted: 4, blocked: 0 });
  assert.equal(f.calls.length, 4);
  assert.ok(f.calls.includes("1:PRECHECKIN"));
  assert.ok(f.calls.includes("1:GUEST_ACCESS_PASSCODE"));
  assert.ok(f.calls.includes("2:PRECHECKIN"));
  assert.ok(f.calls.includes("2:GUEST_ACCESS_PASSCODE"));
  assert.ok(!f.calls.some(call => call.startsWith("3:")));
});

test("pagination visits every candidate across the first 100 rows and beyond", async () => {
  const rows = Array.from({ length: 101 }, (_, index) => row(String(index).padStart(4, "0")));
  const f = fixture(rows);
  const result = await processOtaOperationalCommunications(f.db, env, now, f.deliver, f.reconcile);
  assert.equal(result.candidates, 101);
  assert.equal(result.accepted, 202);
  assert.equal(f.queries, 2);
  assert.equal(new Set(f.calls).size, 202);
});

test("new scan starts at first page; no persistent in-memory cursor", async () => {
  const f = fixture([row("a")]);
  const one = await processOtaOperationalCommunications(f.db, env, now, f.deliver, f.reconcile);
  const two = await processOtaOperationalCommunications(f.db, env, now, f.deliver, f.reconcile);
  assert.equal(one.candidates, 1);
  assert.equal(two.candidates, 1);
  assert.equal(f.queries, 2);
});

test("first switch activation never backfills an access code to an already in-stay guest", async () => {
  const inStay = row("existing-stay");
  inStay.checkIn = new Date(now.getTime() - 24 * 3600000);
  inStay.checkOut = new Date(now.getTime() + 24 * 3600000);
  const f = fixture([inStay]);
  const result = await processOtaOperationalCommunications(f.db, env, now, f.deliver, f.reconcile);
  assert.equal(result.accepted, 0);
  assert.equal(result.blocked, 0);
  assert.deepEqual(f.calls, [], "do not replay pre-checkin or access when check-in has passed");
});

test("upcoming check-in still schedules both operational messages without guest contact", async () => {
  const upcoming = row("upcoming-stay");
  const f = fixture([upcoming]);
  const result = await processOtaOperationalCommunications(f.db, env, now, f.deliver, f.reconcile);
  assert.equal(result.accepted, 2);
  assert.deepEqual(f.calls, ["upcoming-stay:PRECHECKIN", "upcoming-stay:GUEST_ACCESS_PASSCODE"]);
});

test("query excludes all already in-stay access backfill candidates before pagination", async () => {
  const f = fixture([row("upcoming")]);
  let query: any = null;
  f.db.reservation.findMany = async (args: any) => {
    query = args;
    return [];
  };
  await processOtaOperationalCommunications(f.db, env, now, f.deliver, f.reconcile);
  assert.ok(query);
  assert.deepEqual(query.where.OR, [
    { checkIn: { gt: now, lte: new Date(now.getTime() + 4 * 3600000) } },
    { checkOut: { gte: new Date(now.getTime() - 3600000), lte: now } },
  ]);
});
