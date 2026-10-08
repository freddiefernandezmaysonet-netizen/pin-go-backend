import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import express from "express";
import { Resend } from "resend";
import { PrismaClient } from "@prisma/client";

const databaseUrl = process.env.CLEANER_ACCOUNT_TEST_DATABASE_URL;
if (databaseUrl) {
  const url = new URL(databaseUrl);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.pathname !== "/cleaner_account_test") throw new Error("Use an isolated loopback cleaner_account_test database");
}

test("cleaner login, MFA and authorization through real routes and isolated SQL", { skip: !databaseUrl }, async t => {
  // Routes use their existing Prisma instances. All instances receive only the
  // validated disposable URL before modules are imported.
  process.env.DATABASE_URL = databaseUrl!;
  process.env.JWT_SECRET = "local-test-secret-at-least-32-characters";
  process.env.PINGO_MFA_MODE = "ENFORCE";
  process.env.PINGO_SESSION_MODE = "ENFORCE";
  process.env.PINGO_MFA_OTP_PEPPER = "synthetic-mfa-pepper-at-least-32-characters";
  process.env.PINGO_MFA_EMAIL_DELIVERY = "RESEND";
  process.env.RESEND_API_KEY = "re_synthetic_no_network";
  process.env.EMAIL_FROM = "Synthetic <auth@example.com>";
  process.env.ENABLE_DEV_AUTH = "false";
  process.env.CI = "false";
  const realFetch = globalThis.fetch;
  mock.method(globalThis, "fetch", async (input: any, init?: any) => {
    const url = new URL(typeof input === "string" ? input : input.url ?? input.toString());
    if (url.hostname !== "127.0.0.1") throw new Error("External network is forbidden in this test");
    return realFetch(input, init);
  });
  let otp = "";
  let deliveries = 0;
  mock.method(Resend.prototype, "post", async (path: string, entity: any) => {
    assert.equal(path, "/emails");
    otp = String(entity.html).match(/>\s*(\d{6})\s*<\//)?.[1] ?? "";
    assert.match(otp, /^\d{6}$/);
    deliveries++;
    return { data: { id: "synthetic-delivery" }, error: null };
  });
  const { authRouter } = await import("../routes/auth.routes.js");
  const { buildCleanerAccountRouter } = await import("../routes/cleaner-account.routes.js");
  const { buildCleanerSurfaceGuard } = await import("../middleware/cleanerSurfaceGuard.js");
  const { hashPassword } = await import("../lib/auth.js");
  const db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
  const id = `cleaner-login-test-${randomUUID()}`;
  const password = "IndependentCleaning!83";
  const email = `${id}@example.com`;
  await db.organization.create({ data: { id, name: "Synthetic auth organization" } });
  await db.dashboardUser.create({ data: { id, organizationId: id, role: "CLEANER", email, passwordHash: await hashPassword(password), tokenVersion: 1 } });
  await db.staffMember.create({ data: { id, dashboardUserId: id, organizationId: id, fullName: "Synthetic cleaner", preferredLanguage: "es" } });
  const app = express();
  app.use(express.json(), buildCleanerSurfaceGuard(db), authRouter, buildCleanerAccountRouter(db));
  app.get("/legacy-host-data", (_req, res) => res.json({ hostData: true }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address() as { port: number };
  const base = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    mock.restoreAll();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await db.mfaChallenge.deleteMany({ where: { userId: id } });
    await db.authFactor.deleteMany({ where: { userId: id } });
    await db.authSession.deleteMany({ where: { userId: id } });
    await db.trustedDevice.deleteMany({ where: { userId: id } });
    await db.securityEvent.deleteMany({ where: { userId: id } });
    await db.staffMember.delete({ where: { id } });
    await db.dashboardUser.delete({ where: { id } });
    await db.organization.delete({ where: { id } });
    await db.$disconnect();
  });
  const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const login = () => post("/auth/login", { email, password });
  let cookie = "";

  await t.test("wrong password creates neither challenge nor session", async () => {
    assert.equal((await post("/auth/login", { email, password: "wrong" })).status, 401);
    assert.equal(deliveries, 0);
    assert.equal(await db.authSession.count({ where: { userId: id } }), 0);
  });
  await t.test("MFA issues a cleaner session and restricts it to personal data", async () => {
    const response = await login();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("set-cookie"), null);
    const challenge = await response.json();
    assert.equal(challenge.mfaRequired, true);
    const code = otp;
    const wrong = code === "000000" ? "111111" : "000000";
    assert.equal((await post("/auth/mfa/verify", { challengeToken: challenge.challengeToken, code: wrong })).status, 401);
    assert.equal(await db.authSession.count({ where: { userId: id } }), 0);
    const verified = await post("/auth/mfa/verify", { challengeToken: challenge.challengeToken, code });
    assert.equal(verified.status, 200);
    assert.equal((await verified.json()).user.role, "CLEANER");
    cookie = verified.headers.get("set-cookie")!.split(";")[0]!;
    assert.equal((await fetch(`${base}/api/cleaner/me`, { headers: { Cookie: cookie } })).status, 200);
    assert.equal((await fetch(`${base}/legacy-host-data`, { headers: { Cookie: cookie } })).status, 403);
    assert.equal((await post("/auth/mfa/verify", { challengeToken: challenge.challengeToken, code })).status, 423);
  });
  await t.test("Staff disabled between password and MFA cannot verify, resend or use a prior session", async () => {
    const challenge = await (await login()).json();
    const code = otp;
    const before = await db.authSession.count({ where: { userId: id } });
    const sent = deliveries;
    await db.staffMember.update({ where: { id }, data: { isActive: false } });
    assert.equal((await post("/auth/mfa/verify", { challengeToken: challenge.challengeToken, code, trustDevice: true })).status, 404);
    assert.equal((await post("/auth/mfa/resend", { challengeToken: challenge.challengeToken })).status, 404);
    assert.equal((await login()).status, 403);
    assert.equal((await fetch(`${base}/api/cleaner/me`, { headers: { Cookie: cookie } })).status, 403);
    assert.equal(deliveries, sent);
    assert.equal(await db.authSession.count({ where: { userId: id } }), before);
    assert.equal(await db.trustedDevice.count({ where: { userId: id } }), 0);
    await db.staffMember.update({ where: { id }, data: { isActive: true } });
  });
  await t.test("unlinking Staff while MFA is pending blocks verification", async () => {
    const challenge = await (await login()).json();
    const code = otp;
    await db.staffMember.update({ where: { id }, data: { dashboardUserId: null } });
    assert.equal((await post("/auth/mfa/verify", { challengeToken: challenge.challengeToken, code })).status, 404);
    assert.equal((await login()).status, 403);
    await db.staffMember.update({ where: { id }, data: { dashboardUserId: id } });
  });
});
