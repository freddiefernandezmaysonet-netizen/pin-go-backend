import assert from "node:assert/strict";
import test from "node:test";
import { Prisma } from "@prisma/client";
import { ownsAirbnbCommunication, buildAirbnbAccessText } from "./airbnb-access.policy.js";
import { deliverAirbnbCommunication } from "./airbnb-access.service.js";

const booking = "11111111-1111-4111-8111-111111111111";
const remote = "22222222-2222-4222-8222-222222222222";
const thread = "33333333-3333-4333-8333-333333333333";
const message = "44444444-4444-4444-8444-444444444444";
const now = new Date("2026-10-03T18:00:00Z");
const env = { CHANNEX_AIRBNB_ACCESS_ENABLED: "true", CHANNEX_AIRBNB_ACCESS_ORGANIZATION_IDS: "org", CHANNEX_AIRBNB_ACCESS_PROPERTY_IDS: "prop", CHANNEX_AIRBNB_ACCESS_RESERVATION_IDS: "res" };
const relation = (type: string, id: string) => ({ data: { type, id } });
function fixture() {
  const checkIn = new Date("2026-10-03T19:00:00Z"), checkOut = new Date("2026-10-04T15:00:00Z");
  const r: any = { id: "res", propertyId: "prop", source: "AirBNB", externalProvider: "CHANNEX", externalId: booking,
    guestEmail: null, guestPhone: null, preferredLanguage: "es", checkIn, checkOut, status: "ACTIVE", paymentState: "PAID", cancelledAt: null,
    guestAccessReleaseStatus: "RELEASED", guestAccessReleasedAt: now,
    property: { id: "prop", organizationId: "org", name: "Test property", timezone: "America/Puerto_Rico", address1: "Test address" },
    accessGrants: [{ id: "grant", type: "GUEST", method: "PASSCODE_TIMEBOUND", status: "ACTIVE", startsAt: checkIn, endsAt: checkOut,
      lastAppliedAt: now, unlockKey: "#", secureAccessCode: { accessCodeHash: "hash", accessCodeEnc: "encrypted" } }],
  };
  const data: any = { id: thread, type: "message_thread", attributes: { title: "Test", provider: "AirBNB", is_closed: false, message_count: 0, last_message: null, updated_at: now.toISOString() },
    relationships: { property: relation("property", remote), booking: relation("booking", booking) } };
  const receipts = new Map<string, any>();
  let posts = 0, failPost = false, failPersist = false;
  const prisma: any = {
    reservation: { findUnique: async () => structuredClone(r) },
    distributionProperty: { findFirst: async () => ({ externalPropertyId: remote }) },
    messageLog: {
      findUnique: async ({ where }: any) => receipts.get(where.id) ?? null,
      create: async ({ data }: any) => {
        if (receipts.has(data.id)) throw new Prisma.PrismaClientKnownRequestError("duplicate", { code: "P2002", clientVersion: "test" });
        receipts.set(data.id, structuredClone(data)); return data;
      },
      updateMany: async ({ where, data }: any) => {
        if (failPersist) throw new Error("database unavailable");
        const row = receipts.get(where.id);
        if (!row || row.status !== where.status) return { count: 0 };
        Object.assign(row, data); return { count: 1 };
      },
    },
  };
  const request: any = async (input: any) => {
    if (input.method === "POST") {
      posts++;
      if (failPost) throw new Error("secret provider body should never leak");
      return { data: { type: "message", id: message, attributes: { sender: "property", message: input.body.message.message }, relationships: { message_thread: relation("message_thread", thread) } } };
    }
    if (input.path.endsWith("/messages")) return { data: [], meta: { page: 1, limit: 1, total: 0 } };
    if (input.path.endsWith(thread)) return { data };
    return { data: [data], meta: { page: 1, limit: 100, total: 1 } };
  };
  return { r, data, receipts, prisma, request, get posts() { return posts; }, set failPost(v: boolean) { failPost = v; }, set failPersist(v: boolean) { failPersist = v; },
    send: (type: "PRECHECKIN" | "GUEST_ACCESS_PASSCODE" | "CHECKOUT" = "GUEST_ACCESS_PASSCODE") => deliverAirbnbCommunication(prisma, "res", type, { env, now, request, decrypt: () => "987654" }) };
}

test("routing requires source, provenance and exact organization/property/reservation scope", () => {
  const scope = { id: "res", source: "Airbnb", externalProvider: "CHANNEX", externalId: booking, organizationId: "org", propertyId: "prop" };
  assert.equal(ownsAirbnbCommunication(scope, env), true);
  for (const change of [{ source: "BookingCom" }, { externalProvider: "MANUAL" }, { organizationId: "other" }, { propertyId: "other" }, { id: "other" }]) assert.equal(ownsAirbnbCommunication({ ...scope, ...change }, env), false);
  assert.equal(ownsAirbnbCommunication(scope, { ...env, CHANNEX_AIRBNB_ACCESS_ENABLED: "false" }), false);
});
test("contactless Airbnb booking sends once and persists no plaintext code", async () => {
  const f = fixture();
  assert.equal((await f.send())?.status, "SENT");
  assert.equal((await f.send())?.replayed, true);
  assert.equal(f.posts, 1);
  assert.doesNotMatch(JSON.stringify([...f.receipts.values()]), /987654|encrypted|Tu código/);
});
test("concurrent producers use one durable fence", async () => {
  const f = fixture(); await Promise.all(Array.from({ length: 12 }, () => f.send())); assert.equal(f.posts, 1);
});
for (const mode of ["timeout", "persistence"] as const) test(`${mode} uncertainty never retries provider`, async () => {
  const f = fixture(); if (mode === "timeout") f.failPost = true; else f.failPersist = true;
  const first = await f.send(); assert.equal(first?.error, "AIRBNB_SEND_OUTCOME_UNKNOWN");
  await f.send(); assert.equal(f.posts, 1);
  assert.doesNotMatch(JSON.stringify(first), /secret|provider body/);
});
for (const [label, mutate] of [
  ["inquiry without reservation", (f: any) => { f.data.relationships.booking = { data: null }; }],
  ["wrong reservation", (f: any) => { f.data.relationships.booking = relation("booking", remote); }],
  ["wrong property", (f: any) => { f.data.relationships.property = relation("property", booking); }],
  ["closed thread", (f: any) => { f.data.attributes.is_closed = true; }],
  ["wrong OTA", (f: any) => { f.data.attributes.provider = "BookingCom"; }],
  ["cancelled", (f: any) => { f.r.status = "CANCELLED"; }],
  ["unpaid", (f: any) => { f.r.paymentState = "NONE"; }],
  ["unreleased", (f: any) => { f.r.guestAccessReleaseStatus = "PENDING"; }],
  ["revoked", (f: any) => { f.r.accessGrants[0].status = "REVOKED"; }],
  ["stale validity", (f: any) => { f.r.accessGrants[0].endsAt = now; }],
  ["ambiguous grant", (f: any) => { f.r.accessGrants.push(f.r.accessGrants[0]); }],
] as const) test(`${label} never transmits a credential`, async () => {
  const f = fixture(); mutate(f); assert.equal((await f.send())?.ok, false); assert.equal(f.posts, 0);
});
test("credential change before send is rejected", async () => {
  const f = fixture(); let calls = 0;
  f.prisma.reservation.findUnique = async () => { const r = structuredClone(f.r); if (++calls > 1) r.accessGrants[0].secureAccessCode.accessCodeHash = "changed"; return r; };
  assert.equal((await f.send())?.error, "AIRBNB_RESERVATION_CHANGED"); assert.equal(f.posts, 0);
});
test("other sources keep their existing delivery path", async () => {
  const f = fixture(); f.r.source = "BookingCom"; assert.equal(await f.send(), null); assert.equal(f.posts, 0);
});
test("arrival and departure respect their schedule", async () => {
  const f = fixture(); assert.equal((await f.send("PRECHECKIN"))?.ok, true); assert.equal((await f.send("CHECKOUT"))?.ok, false);
});
test("access text contains both validity dates, timezone and unlock key", () => {
  const f = fixture(); const text = buildAirbnbAccessText({ type: "GUEST_ACCESS_PASSCODE", propertyName: "Test", language: "en", timezone: "America/Puerto_Rico", checkIn: f.r.checkIn, checkOut: f.r.checkOut, code: "987654", unlockKey: "*" });
  assert.match(text, /Valid from.*until/); assert.match(text, /America\/Puerto_Rico/); assert.match(text, /press \*/);
});
