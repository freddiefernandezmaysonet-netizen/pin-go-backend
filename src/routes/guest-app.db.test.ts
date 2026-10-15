import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import express from "express";
import { PrismaClient } from "@prisma/client";
import { buildGuestAppRouter, renderGuestAppEntry } from "./guest-app.routes.js";
import { exchangeGuestStayToken, readGuestMobileStay, resolveGuestMobileSession } from "../guest-mobile/guest-mobile-session.service.js";
import { readGuestMobileAccessCodes } from "../guest-mobile/guest-mobile-access-code.service.js";

// Execute the released app's production parser, not a test-only reimplementation.
function loadMobile(file: string): Record<string, any> {
  const root = process.env.GUEST_APP_SOURCE;
  assert.ok(root, "GUEST_APP_SOURCE must point to the pinned Guest release checkout");
  const filename = path.resolve(root, file);
  const source = ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  new Function("require", "exports", source)((specifier: string) => {
    assert.ok(specifier.startsWith("."), "Only pure native link helpers are loaded");
    return loadMobile(path.relative(root, path.resolve(path.dirname(filename), specifier) + ".ts"));
  }, exports);
  return exports;
}

test("portal to released Guest app with no phone or SMS, real Prisma and session recovery", async t => {
  const TEST_URL = "postgresql://guest_app_ci:guest_app_ci@127.0.0.1:5432/guest_app_ci";
  assert.equal(process.env.GUEST_APP_DB_TEST, "true");
  assert.equal(process.env.DATABASE_URL, TEST_URL, "Refusing any non-test database");
  const db = new PrismaClient({ datasources: { db: { url: TEST_URL } } });
  t.after(() => db.$disconnect());
  assert.equal(await db.organization.count(), 0, "Requires an empty disposable database; never reset existing data");
  const organization = await db.organization.create({ data: { name: "Synthetic app handoff" } });
  const property = await db.property.create({ data: { organizationId: organization.id, name: "Synthetic stay" } });
  const token = "synthetic_stay_link_20261015_0001";
  const future = new Date(Date.now() + 86_400_000);
  const past = new Date(Date.now() - 86_400_000);
  const reservation = await db.reservation.create({ data: {
    propertyId: property.id, guestName: "Synthetic guest", guestEmail: "synthetic@example.invalid",
    guestPhone: null, externalRaw: { consent: { smsConsent: false } },
    reservationNumber: "PG-HANDOFF-TEST", guestToken: token, guestTokenExpiresAt: future,
    checkIn: new Date(), checkOut: future, status: "ACTIVE", guestAccessReleaseStatus: "BLOCKED",
  } });
  const app = express();
  app.use(buildGuestAppRouter(db));
  const server = createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = (value = token) => fetch(`${base}/guest/app/${value}`, { redirect: "manual" });

  await t.test("portal offers explicit native handoff and browser fallback, without automatic redirect", async () => {
    assert.match(renderGuestAppEntry(token, "en"), new RegExp(`/guest/app/${token}`));
    const response = await get();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    assert.match(response.headers.get("content-security-policy")!, /default-src 'none'/);
    assert.equal(response.headers.get("location"), null);
    const html = await response.text();
    assert.match(html, /Open in Pin&amp;Go Guest/);
    assert.match(html, new RegExp(`href="/guest/verify/${token}"`));
    assert.match(html, /do not need to receive SMS/);
    assert.doesNotMatch(html, /<script|http-equiv="refresh"|https?:\/\//);
    const nativeUrl = html.match(/href="(pingo-guest:[^"]+)"/)![1]!;
    const { guestTokenFromUrl } = loadMobile("src/guest/deepLink.ts");
    const { redirectSystemPath } = loadMobile("app/+native-intent.tsx");
    assert.equal(guestTokenFromUrl(nativeUrl), token);
    for (const initial of [true, false]) {
      assert.equal(redirectSystemPath({ path: nativeUrl, initial }), `/?guestToken=${token}`);
    }
    const exchanged = await exchangeGuestStayToken(db, { guestToken: guestTokenFromUrl(nativeUrl), platform: "ios" });
    const restored = await resolveGuestMobileSession(db, exchanged.bearer);
    assert.equal(restored.guestPersonId, exchanged.guestPersonId);
    const stay = await readGuestMobileStay(db, { guestPersonId: restored.guestPersonId, reservationNumber: exchanged.stay.reservationNumber });
    assert.equal(stay.reservationNumber, reservation.reservationNumber);
    assert.ok(stay.reservationNumber);
    assert.equal(stay.accessReleaseStatus, "BLOCKED");
    assert.deepEqual(await readGuestMobileAccessCodes(db, { guestPersonId: restored.guestPersonId, reservationNumber: stay.reservationNumber }), { status: "UNAVAILABLE", codes: [] });
    const stored = await db.guestDeviceSession.findUniqueOrThrow({ where: { id: exchanged.sessionId } });
    assert.notEqual(stored.tokenHash, exchanged.bearer);
    await db.guestDeviceSession.update({ where: { id: stored.id }, data: { revokedAt: new Date() } });
    await assert.rejects(resolveGuestMobileSession(db, exchanged.bearer), /UNAUTHENTICATED/);
    await db.guestDeviceSession.update({ where: { id: stored.id }, data: { revokedAt: null, expiresAt: past } });
    await assert.rejects(resolveGuestMobileSession(db, exchanged.bearer), /UNAUTHENTICATED/);
  });
  await t.test("Spanish instructions", async () => {
    await db.reservation.update({ where: { id: reservation.id }, data: { preferredLanguage: "es-PR" } });
    assert.match(await (await get()).text(), /Abrir en Pin&amp;Go Guest/);
  });
  const unavailable = async () => {
    const response = await get();
    assert.equal(response.status, 404);
    assert.doesNotMatch(await response.text(), /pingo-guest:|synthetic_stay_link/);
  };
  await t.test("cancelled reservation, expired token and ended stay cannot open the app", async () => {
    await db.reservation.update({ where: { id: reservation.id }, data: { status: "CANCELLED" } });
    await unavailable();
    await db.reservation.update({ where: { id: reservation.id }, data: { status: "ACTIVE", guestTokenExpiresAt: past } });
    await unavailable();
    await db.reservation.update({ where: { id: reservation.id }, data: { guestTokenExpiresAt: future, checkOut: past } });
    await unavailable();
    await db.reservation.update({ where: { id: reservation.id }, data: { checkOut: future } });
  });
  await t.test("revoked stay link blocks the handoff and native exchange", async () => {
    await db.guestStayLink.update({ where: { reservationId: reservation.id }, data: { revokedAt: new Date() } });
    await unavailable();
    await assert.rejects(exchangeGuestStayToken(db, { guestToken: token }), /STAY_LINK_REVOKED/);
  });
  await t.test("inactive property blocks the handoff", async () => {
    await db.guestStayLink.update({ where: { reservationId: reservation.id }, data: { revokedAt: null } });
    await db.property.update({ where: { id: property.id }, data: { status: "INACTIVE" } });
    await unavailable();
    await db.property.update({ where: { id: property.id }, data: { status: "ACTIVE" } });
  });
  await t.test("malformed and unknown tokens never appear in an app link", async () => {
    for (const invalid of ["short", "a".repeat(201), "unknown_stay_token_123456789", "%22%3E%3Cscript%3E"]) {
      const response = await get(invalid);
      assert.equal(response.status, 404);
      assert.doesNotMatch(await response.text(), /pingo-guest:|<script>/);
    }
    assert.equal(renderGuestAppEntry('bad" onclick="alert(1)'), "");
  });
  assert.equal(await db.messageLog.count(), 0, "No emails or SMS are dispatched by this test");
});
