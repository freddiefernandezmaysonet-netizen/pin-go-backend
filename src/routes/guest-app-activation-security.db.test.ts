import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { PrismaClient } from "@prisma/client";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import { buildGuestAppRouter } from "./guest-app.routes.js";
import { exchangeGuestStayToken, resolveGuestMobileSession } from "../guest-mobile/guest-mobile-session.service.js";
import { activationHash, requestOtaGuestAppActivation, verifyOtaGuestAppActivation } from "../guest-mobile/ota-guest-app-activation.service.js";

test("OTA activation security with real PostgreSQL and HTTP", async t => {
  const testUrl = "postgresql://guest_app_ci:guest_app_ci@127.0.0.1:5432/guest_app_ci";
  assert.equal(process.env.GUEST_APP_DB_TEST, "true");
  assert.equal(process.env.DATABASE_URL, testUrl, "Never use an existing customer database");
  const db = new PrismaClient({ datasources: { db: { url: testUrl } } });
  t.after(() => db.$disconnect());
  const org = await db.organization.create({ data: { name: "Synthetic activation security" } });
  const property = await db.property.create({ data: { organizationId: org.id, name: "Synthetic OTA property" } });
  const now = new Date();
  const future = new Date(+now + 86_400_000);
  const browserSecret = randomBytes(32).toString("base64url");
  let number = 0;
  async function stay(source = "AIRBNB") {
    return db.reservation.create({ data: {
      propertyId: property.id, guestName: "Synthetic guest", guestPhone: null, guestEmail: ["DIRECT_BOOKING", "EXPEDIA", "VRBO"].includes(source) ? "guest@example.invalid" : null,
      reservationNumber: `PG-SECURITY-${++number}`, source, externalProvider: source === "DIRECT_BOOKING" ? "PIN_GO_DIRECT" : "CHANNEX", externalId: randomBytes(16).toString("hex"),
      status: "ACTIVE", paymentState: "PAID", preferredLanguage: "es", checkIn: now, checkOut: future,
      guestToken: randomBytes(32).toString("base64url"), guestTokenExpiresAt: future, guestAccessReleaseStatus: "RELEASED",
    } });
  }
  async function challenge(guestToken: string, at = now, accepted = true) {
    let sent: { reservationId: string; challengeId: string; code: string } | undefined;
    const result = await requestOtaGuestAppActivation(db, { guestToken, browserSecret, now: at }, async input => { sent = input; return accepted; });
    return { ...result, code: sent!.code };
  }
  async function verified(guestToken: string, at = now) {
    const c = await challenge(guestToken, at);
    return verifyOtaGuestAppActivation(db, { guestToken, browserSecret, challengeId: c.id, code: c.code, now: at });
  }

  await t.test("a copied raw link cannot create the first or any additional OTA session", async () => {
    for (const provider of ["AIRBNB", "BOOKING_COM", "DIRECT_BOOKING", "EXPEDIA", "VRBO"]) {
      const r = await stay(provider);
      await assert.rejects(exchangeGuestStayToken(db, { guestToken: r.guestToken, now }), /ACTIVATION_REQUIRED/);
      assert.equal(await db.guestStayLink.count({ where: { reservationId: r.id } }), 0);
      const activationToken = await verified(r.guestToken!);
      const linked = await exchangeGuestStayToken(db, { guestToken: activationToken, now });
      assert.equal(+linked.expiresAt, +r.checkOut);
      assert.equal((await resolveGuestMobileSession(db, linked.bearer, now)).id, linked.sessionId);
      await assert.rejects(exchangeGuestStayToken(db, { guestToken: r.guestToken, now }), /ACTIVATION_REQUIRED/);
      await assert.rejects(exchangeGuestStayToken(db, { guestToken: activationToken, now }), /ACTIVATION_REQUIRED/);
    }
  });
  await t.test("verification is bound to its requesting browser and reservation; attempts cannot be reset by retrying", async () => {
    const r = await stay(), other = await stay();
    const c = await challenge(r.guestToken!);
    await assert.rejects(verifyOtaGuestAppActivation(db, { guestToken: r.guestToken!, browserSecret: randomBytes(32).toString("base64url"), challengeId: c.id, code: c.code, now }), /INVALID_CODE/);
    await assert.rejects(verifyOtaGuestAppActivation(db, { guestToken: other.guestToken!, browserSecret, challengeId: c.id, code: c.code, now }), /INVALID_CODE/);
    const wrongCode = c.code === "000000" ? "111111" : "000000";
    await Promise.all(Array.from({ length: 5 }, () => assert.rejects(
      verifyOtaGuestAppActivation(db, { guestToken: r.guestToken!, browserSecret, challengeId: c.id, code: wrongCode, now }), /INVALID_CODE/)));
    assert.equal((await db.guestAppActivationChallenge.findUniqueOrThrow({ where: { id: c.id } })).attempts, 5);
    await assert.rejects(verifyOtaGuestAppActivation(db, { guestToken: r.guestToken!, browserSecret, challengeId: c.id, code: c.code, now }), /INVALID_CODE/);
  });
  await t.test("parallel exchanges can consume an activation only once", async () => {
    const r = await stay(); const token = await verified(r.guestToken!);
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => exchangeGuestStayToken(db, { guestToken: token, now })));
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    assert.equal(await db.guestDeviceSession.count({ where: { guestAppActivation: { reservationId: r.id } } }), 1);
  });
  await t.test("changing the saved email invalidates pending Direct Booking, Expedia and Vrbo verification", async () => {
    for (const source of ["DIRECT_BOOKING", "EXPEDIA", "VRBO"]) {
      const r = await stay(source); const c = await challenge(r.guestToken!);
      await db.reservation.update({ where: { id: r.id }, data: { guestEmail: "changed@example.invalid" } });
      await assert.rejects(verifyOtaGuestAppActivation(db, { guestToken: r.guestToken!, browserSecret, challengeId: c.id, code: c.code, now }), /INVALID_CODE/);
      await db.reservation.update({ where: { id: r.id }, data: { guestEmail: null } });
      await assert.rejects(challenge(r.guestToken!, new Date(+now + 61_000)), /UNAVAILABLE/);
    }
  });
  await t.test("every additional device requires fresh channel proof, including recovery on a new phone", async () => {
    const r = await stay();
    const first = await exchangeGuestStayToken(db, { guestToken: await verified(r.guestToken!), now });
    const later = new Date(+now + 61_000);
    const second = await exchangeGuestStayToken(db, { guestToken: await verified(r.guestToken!, later), now: later });
    assert.notEqual(first.sessionId, second.sessionId);
    assert.equal(first.guestPersonId, second.guestPersonId);
  });
  await t.test("code and activation bearer expire independently", async () => {
    const r = await stay(); const c = await challenge(r.guestToken!);
    await assert.rejects(verifyOtaGuestAppActivation(db, { guestToken: r.guestToken!, browserSecret, challengeId: c.id, code: c.code, now: new Date(+now + 600_001) }), /INVALID_CODE/);
    const other = await stay(); const token = await verified(other.guestToken!);
    await assert.rejects(exchangeGuestStayToken(db, { guestToken: token, now: new Date(+now + 120_001) }), /ACTIVATION_REQUIRED/);
  });
  await t.test("uncertain delivery never grants proof and only hashes are stored", async () => {
    const r = await stay();
    let code = "", id = "";
    await assert.rejects(requestOtaGuestAppActivation(db, { guestToken: r.guestToken!, browserSecret, now }, async input => {
      code = input.code; id = input.challengeId; throw Error("synthetic timeout");
    }), /DELIVERY_FAILED/);
    const row = await db.guestAppActivationChallenge.findUniqueOrThrow({ where: { id } });
    assert.equal(row.deliveredAt, null);
    assert.equal(row.codeHash, activationHash(`${id}:${code}:${browserSecret}:CHANNEX:${r.externalId}`));
    assert.equal(row.guestTokenHash, activationHash(r.guestToken!));
    assert.equal(row.browserHash, activationHash(browserSecret));
    await assert.rejects(verifyOtaGuestAppActivation(db, { guestToken: r.guestToken!, browserSecret, challengeId: id, code, now }), /INVALID_CODE/);
  });
  await t.test("rate limits apply across browsers and simultaneous requests for the same booking", async () => {
    const r = await stay();
    const requests = await Promise.allSettled(Array.from({ length: 5 }, () => challenge(r.guestToken!)));
    assert.equal(requests.filter(r => r.status === "fulfilled").length, 1);
    for (let minute = 1; minute <= 4; minute++) await challenge(r.guestToken!, new Date(+now + minute * 61_000));
    await assert.rejects(challenge(r.guestToken!, new Date(+now + 6 * 61_000)), /RATE_LIMITED/);
  });
  await t.test("legacy OTA sessions, revoked proof, token rotation, cancellation, inactive property and checkout deny sessions", async () => {
    const r = await stay(); const token = await verified(r.guestToken!);
    const linked = await exchangeGuestStayToken(db, { guestToken: token, now });
    const legacyBearer = randomBytes(32).toString("base64url");
    await db.guestDeviceSession.create({ data: { guestPersonId: linked.guestPersonId, tokenHash: activationHash(legacyBearer), expiresAt: future } });
    await assert.rejects(resolveGuestMobileSession(db, legacyBearer, now), /UNAUTHENTICATED/);
    const proof = await db.guestAppActivationChallenge.findUniqueOrThrow({ where: { activationTokenHash: activationHash(token) } });
    await db.guestAppActivationChallenge.update({ where: { id: proof.id }, data: { revokedAt: now } });
    await assert.rejects(resolveGuestMobileSession(db, linked.bearer, now), /UNAUTHENTICATED/);
    await db.guestAppActivationChallenge.update({ where: { id: proof.id }, data: { revokedAt: null } });
    await db.reservation.update({ where: { id: r.id }, data: { guestToken: randomBytes(32).toString("base64url") } });
    await assert.rejects(resolveGuestMobileSession(db, linked.bearer, now), /UNAUTHENTICATED/);
    await db.reservation.update({ where: { id: r.id }, data: { guestToken: r.guestToken, status: "CANCELLED" } });
    await assert.rejects(resolveGuestMobileSession(db, linked.bearer, now), /UNAUTHENTICATED/);
    await db.reservation.update({ where: { id: r.id }, data: { status: "ACTIVE" } });
    await db.property.update({ where: { id: property.id }, data: { status: "INACTIVE" } });
    await assert.rejects(resolveGuestMobileSession(db, linked.bearer, now), /UNAUTHENTICATED/);
    await db.property.update({ where: { id: property.id }, data: { status: "ACTIVE" } });
    await assert.rejects(resolveGuestMobileSession(db, linked.bearer, future), /UNAUTHENTICATED/);
  });

  await t.test("HTTP requires explicit CSRF-protected confirmation; no native token is exposed before proof", async () => {
    const r = await stay(); let sentCode = "", sends = 0;
    const app = express(); app.use(express.urlencoded({ extended: false }));
    app.use(buildGuestAppRouter(db, { deliverVerification: async input => { sends++; sentCode = input.code; return true; } }));
    const server = app.listen(0, "127.0.0.1"); await new Promise<void>(resolve => server.once("listening", resolve));
    t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/guest/app/${r.guestToken}`;
    const initial = await fetch(url), html = await initial.text();
    assert.doesNotMatch(html, /pingo-guest:/); assert.equal(sends, 0);
    const cookie = initial.headers.get("set-cookie")!.split(";")[0];
    const csrf = html.match(/name="csrf" value="([^"]+)"/)![1];
    const post = (action: string, body: Record<string, string>, withCookie = true) => fetch(`${url}/${action}`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...(withCookie ? { cookie } : {}) }, body: new URLSearchParams(body),
    });
    assert.equal((await post("request", { csrf }, false)).status, 403);
    assert.equal((await post("request", { csrf: "wrong" })).status, 403); assert.equal(sends, 0);
    const pending = await post("request", { csrf }); assert.equal(pending.status, 200); assert.equal(sends, 1);
    const pendingHtml = await pending.text(); assert.doesNotMatch(pendingHtml, /pingo-guest:/);
    assert.ok(!pendingHtml.includes(sentCode));
    const challengeId = pendingHtml.match(/name="challengeId" value="([^"]+)"/)![1];
    const confirmed = await post("verify", { csrf, challengeId, code: sentCode }); assert.equal(confirmed.status, 200);
    const ready = await confirmed.text();
    const native = ready.match(/href="pingo-guest:\/\/stay\/([^"]+)"/)![1];
    assert.ok(native.startsWith("gact_")); assert.notEqual(native, r.guestToken);
    assert.match(ready, new RegExp(`/guest/verify/${r.guestToken}`));
    await exchangeGuestStayToken(db, { guestToken: native });
    assert.equal((await post("verify", { csrf, challengeId, code: sentCode })).status, 400);
  });
});
