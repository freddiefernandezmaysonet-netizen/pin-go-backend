import assert from "node:assert/strict";
import test from "node:test";
import { Prisma } from "@prisma/client";
import { deliverOtaOperationalCommunication } from "./ota-operational-guest.service.js";
import type { AirbnbCommunicationType } from "./airbnb-access.policy.js";

const booking = "11111111-1111-4111-8111-111111111111";
const remote = "22222222-2222-4222-8222-222222222222";
const thread = "33333333-3333-4333-8333-333333333333";
const message = "44444444-4444-4444-8444-444444444444";
const now = new Date("2026-10-03T18:00:00Z");
const env = {
  OTA_GUEST_EXTERNAL_MESSAGING_BLOCKED_PROVIDERS: "AIRBNB,BOOKING_COM",
  CHANNEX_AIRBNB_ACCESS_ENABLED: "false",
} as NodeJS.ProcessEnv;
const rel = (type: string, id: string) => ({ data: { type, id } });

function fixture(source = "BookingCom") {
  const checkIn = new Date("2026-10-03T19:00:00Z");
  const checkOut = new Date("2026-10-04T15:00:00Z");
  const reservation: any = {
    id: "res", propertyId: "prop", source, externalProvider: "CHANNEX", externalId: booking,
    guestEmail: null, guestPhone: null, preferredLanguage: "es",
    guestToken: "private_test_stay_token_123456", guestTokenExpiresAt: checkOut, guestStayLink: null,
    checkIn, checkOut, status: "ACTIVE", paymentState: "PAID", cancelledAt: null,
    guestAccessReleaseStatus: "RELEASED", guestAccessReleasedAt: now,
    property: {
      id: "prop", organizationId: "org", status: "ACTIVE", name: "Property",
      timezone: "America/Puerto_Rico", address1: "Test address",
    },
    accessGrants: [{
      id: "grant", type: "GUEST", method: "PASSCODE_TIMEBOUND", status: "ACTIVE",
      startsAt: checkIn, endsAt: checkOut, lastAppliedAt: now,
      unlockKey: "#", secureAccessCode: { accessCodeHash: "hash", accessCodeEnc: "encrypted",
        startDate: BigInt(checkIn.getTime()), endDate: BigInt(checkOut.getTime()) },
    }],
  };
  const threadData: any = {
    id: thread, type: "message_thread",
    attributes: {
      title: "Test", provider: source, is_closed: false,
      message_count: 0, last_message: null, updated_at: now.toISOString(),
    },
    relationships: { property: rel("property", remote), booking: rel("booking", booking) },
  };
  const sentTexts: string[] = [];
  let posts = 0, failPost = false, failSave = false;
  const receipts = new Map<string, any>();
  const prisma: any = {
    reservation: { findUnique: async () => structuredClone(reservation) },
    distributionProperty: { findFirst: async () => ({ externalPropertyId: remote }) },
    messageLog: {
      findUnique: async ({ where }: any) => receipts.get(where.id) ?? null,
      create: async ({ data }: any) => {
        if (receipts.has(data.id)) {
          throw new Prisma.PrismaClientKnownRequestError("duplicate", {
            code: "P2002", clientVersion: "test",
          });
        }
        receipts.set(data.id, structuredClone(data));
        return data;
      },
      updateMany: async ({ where, data }: any) => {
        if (failSave) throw Error("database unavailable");
        const row = receipts.get(where.id);
        if (!row || row.status !== where.status) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      },
    },
  };
  const request: any = async (input: any) => {
    if (input.method === "POST") {
      posts++;
      sentTexts.push(input.body.message.message);
      if (failPost) throw Error("private provider failure");
      return {
        data: {
          id: message, type: "message",
          attributes: { sender: "property", message: input.body.message.message },
          relationships: { message_thread: rel("message_thread", thread) },
        },
      };
    }
    if (input.path.endsWith("/messages"))
      return { data: [], meta: { page: 1, limit: 1, total: 0 } };
    if (input.path.endsWith(thread)) return { data: threadData };
    return { data: [threadData], meta: { page: 1, limit: 100, total: 1 } };
  };
  const send = (type: AirbnbCommunicationType = "GUEST_ACCESS_PASSCODE",
    providedEnv = env,
    activationVerification?: { challengeId: string; code: string },
  ) => deliverOtaOperationalCommunication(prisma, "res", type, {
    env: providedEnv, now, request, decrypt: () => "987654", ...(activationVerification ? { activationVerification } : {}),
  });
  return {
    reservation, threadData, receipts, prisma, send, sentTexts,
    get posts() { return posts; },
    set failPost(v: boolean) { failPost = v; },
    set failSave(v: boolean) { failSave = v; },
  };
}

for (const source of ["Airbnb", "BookingCom"]) {
  test(`${source}: device verification uses the verified booking thread, a challenge-scoped receipt and no logged code`, async () => {
    const f = fixture(source);
    const verification = { challengeId: "c".repeat(32), code: "123456" };
    assert.equal((await f.send("GUEST_APP_DEVICE_VERIFICATION", env, verification))?.ok, true);
    assert.equal((await f.send("GUEST_APP_DEVICE_VERIFICATION", env, verification))?.ok, true);
    assert.equal(f.posts, 1);
    assert.match(f.sentTexts[0]!, /123456/);
    assert.match(f.sentTexts[0]!, /No es el código de la puerta/);
    assert.doesNotMatch(f.sentTexts[0]!, /987654|guest\/app|pingo-guest:/);
    assert.ok(!JSON.stringify([...f.receipts.values()]).includes("123456"));
    assert.equal((await f.send("GUEST_APP_DEVICE_VERIFICATION", env, { ...verification, challengeId: "d".repeat(32) }))?.ok, true);
    assert.equal(f.posts, 2);
  });
}
test("uncertain device verification sends are not repeated and malformed verification cannot send", async () => {
  const f = fixture(); f.failPost = true;
  const verification = { challengeId: "c".repeat(32), code: "123456" };
  assert.equal((await f.send("GUEST_APP_DEVICE_VERIFICATION", env, verification))?.ok, false);
  assert.equal((await f.send("GUEST_APP_DEVICE_VERIFICATION", env, verification))?.ok, false);
  assert.equal(f.posts, 1);
  assert.equal((await f.send("GUEST_APP_DEVICE_VERIFICATION", env, { ...verification, code: "bad" }))?.ok, false);
  assert.equal(f.posts, 1);
});

test("preflight identifies invalid thread metadata without exposing payloads", async () => {
  const f = fixture();
  f.threadData.attributes.last_message = { private: "do not log this" };
  const result = await f.send();
  assert.equal(result?.error, "OTA_OPERATIONAL_PREFLIGHT_THREAD_LIST_HOST_INBOX_RESPONSE_INVALID");
  assert.equal(f.posts, 0);
  assert.doesNotMatch(JSON.stringify(result), /private|do not log/);
});

test("preflight categorizes internal failures without revealing exception details", async () => {
  const f = fixture();
  let reads = 0;
  f.prisma.reservation.findUnique = async () => {
    if (++reads > 1) throw Error("private database credential");
    return structuredClone(f.reservation);
  };
  const result = await f.send();
  assert.equal(result?.error, "OTA_OPERATIONAL_PREFLIGHT_RESERVATION_RECHECK_INTERNAL");
  assert.equal(f.posts, 0);
  assert.doesNotMatch(JSON.stringify(result), /private|credential/);
});

for (const source of ["BookingCom", "Airbnb"]) {
  test(source + " sends access once without a phone/email", async () => {
    const f = fixture(source);
    assert.equal((await f.send())?.status, "SENT");
    assert.equal((await f.send())?.replayed, true);
    assert.equal(f.posts, 1);
    assert.doesNotMatch(JSON.stringify([...f.receipts.values()]), /987654|encrypted/);
  });
  test(source + " concurrent producers send once", async () => {
    const f = fixture(source);
    await Promise.all(Array.from({ length: 8 }, () => f.send()));
    assert.equal(f.posts, 1);
  });
}

test("existing paths remain unchanged when OTA switch is unset", async () => {
  const f = fixture();
  assert.equal(await f.send("GUEST_ACCESS_PASSCODE", {
    OTA_GUEST_EXTERNAL_MESSAGING_BLOCKED_PROVIDERS: "",
    CHANNEX_AIRBNB_ACCESS_ENABLED: "false",
  }), null);
  assert.equal(f.posts, 0);
});

test("Booking.com sends scheduled pre-checkin but not premature checkout", async () => {
  const f = fixture();
  assert.equal((await f.send("PRECHECKIN"))?.status, "SENT");
  assert.equal((await f.send("CHECKOUT"))?.ok, false);
  assert.equal(f.posts, 1);
});

test("unknown transport outcome is not retried", async () => {
  const f = fixture();
  f.failPost = true;
  assert.equal((await f.send())?.error, "OTA_OPERATIONAL_SEND_OUTCOME_UNKNOWN");
  assert.equal((await f.send())?.ok, false);
  assert.equal(f.posts, 1);
});

test("receipt persistence failure is not retried", async () => {
  const f = fixture();
  f.failSave = true;
  assert.equal((await f.send())?.error, "OTA_OPERATIONAL_SEND_OUTCOME_UNKNOWN");
  assert.equal((await f.send())?.ok, false);
  assert.equal(f.posts, 1);
});

for (const [name, mutate] of [
  ["unsupported provider", (f: ReturnType<typeof fixture>) => { f.reservation.source = "VRBO"; }],
  ["wrong channel on thread", (f: ReturnType<typeof fixture>) => { f.threadData.attributes.provider = "Airbnb"; }],
  ["missing booking relation", (f: ReturnType<typeof fixture>) => { f.threadData.relationships.booking = { data: null }; }],
  ["closed thread", (f: ReturnType<typeof fixture>) => { f.threadData.attributes.is_closed = true; }],
  ["cancelled reservation", (f: ReturnType<typeof fixture>) => { f.reservation.status = "CANCELLED"; }],
  ["unpaid reservation", (f: ReturnType<typeof fixture>) => { f.reservation.paymentState = "NONE"; }],
  ["revoked grant", (f: ReturnType<typeof fixture>) => { f.reservation.accessGrants[0].status = "REVOKED"; }],
  ["retracted access", (f: ReturnType<typeof fixture>) => { f.reservation.guestAccessReleaseStatus = "PENDING"; }],
] as const) {
  test(name + " does not send to Channex", async () => {
    const f = fixture();
    mutate(f);
    assert.notEqual((await f.send())?.ok, true);
    assert.equal(f.posts, 0);
  });
}

test("changed access code invalidates the send", async () => {
  const f = fixture();
  let reads = 0;
  f.prisma.reservation.findUnique = async () => {
    const r = structuredClone(f.reservation);
    if (++reads >= 2) r.accessGrants[0].secureAccessCode.accessCodeHash = "changed";
    return r;
  };
  assert.equal((await f.send())?.error, "OTA_OPERATIONAL_RESERVATION_CHANGED");
  assert.equal(f.posts, 0);
});

test("changed BigInt access validity blocks dispatch without rounding", async () => {
  const f = fixture();
  let reads = 0;
  f.prisma.reservation.findUnique = async () => {
    const r = structuredClone(f.reservation);
    if (++reads >= 2) r.accessGrants[0].secureAccessCode.endDate += 1n;
    return r;
  };
  assert.equal((await f.send())?.error, "OTA_OPERATIONAL_RESERVATION_CHANGED");
  assert.equal(f.posts, 0);
});

for (const source of ["BookingCom", "Airbnb"]) {
  test(source + " activation uses existing token once after an already-sent access message", async () => {
    const f = fixture(source);
    assert.equal((await f.send())?.ok, true);
    assert.equal((await f.send("GUEST_APP_ACTIVATION"))?.ok, true);
    assert.equal((await f.send("GUEST_APP_ACTIVATION"))?.replayed, true);
    assert.equal(f.posts, 2);
    assert.equal(f.sentTexts.filter(text => text.includes("987654")).length, 1);
    assert.ok(f.sentTexts[1]!.includes("https://api.pin-ngo.com/guest/app/private_test_stay_token_123456"));
    assert.match(f.sentTexts[1]!, /vuelve a abrir/);
    assert.doesNotMatch(JSON.stringify([...f.receipts.values()]), /private_test_stay_token|987654/);
  });
}
for (const state of ["missing", "expired", "revoked"] as const) {
  test(state + " stay token blocks activation but preserves access delivery", async () => {
    const f = fixture();
    if (state === "missing") f.reservation.guestToken = null;
    if (state === "expired") f.reservation.guestTokenExpiresAt = now;
    if (state === "revoked") f.reservation.guestStayLink = { revokedAt: now };
    assert.equal((await f.send())?.ok, true);
    assert.equal((await f.send("GUEST_APP_ACTIVATION"))?.error, "OTA_OPERATIONAL_GUEST_APP_LINK_UNAVAILABLE");
    assert.equal(f.posts, 1);
  });
}
test("activation timeout never repeats the provider POST", async () => {
  const f = fixture(); f.failPost = true;
  assert.equal((await f.send("GUEST_APP_ACTIVATION"))?.error, "OTA_OPERATIONAL_SEND_OUTCOME_UNKNOWN");
  await f.send("GUEST_APP_ACTIVATION");
  assert.equal(f.posts, 1);
});
