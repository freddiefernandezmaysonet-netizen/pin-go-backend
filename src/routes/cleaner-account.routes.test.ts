import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { buildCleanerAccountRouter } from "./cleaner-account.routes.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { cleanerSurfaceAllowed } from "../auth/cleaner-surface.policy.js";
import { buildCleanerSurfaceGuard } from "../middleware/cleanerSurfaceGuard.js";
import { signAuthToken } from "../lib/auth.js";

test("cleaner surface denies host and signup paths", () => {
  for (const path of ["/staff", "/api/properties", "/api/team/users", "/api/dashboard/overview", "/api/auth/register-organization", "/api/cleaner-other/me"]) assert.equal(cleanerSurfaceAllowed(path), false, path);
  for (const path of ["/api/cleaner/me", "/api/cleaner/cleanings?organizationId=other", "/auth/me", "/auth/logout", "/cleaning/confirm/offer/confirm"]) assert.equal(cleanerSurfaceAllowed(path), true, path);
});

test("requireAuth rejects an authenticated cleaner on a host route", async () => {
  const oldCi = process.env.CI; const oldNode = process.env.NODE_ENV;
  process.env.CI = "true"; process.env.NODE_ENV = "test";
  try {
    let status = 0; let continued = false;
    const req: any = { originalUrl: "/api/properties", user: { id: "user", orgId: "org", role: "CLEANER" } };
    const res: any = { status(value: number) { status = value; return this; }, json() { return this; } };
    await requireAuth(req, res, () => { continued = true; });
    assert.equal(status, 403); assert.equal(continued, false);
  } finally {
    if (oldCi === undefined) delete process.env.CI; else process.env.CI = oldCi;
    if (oldNode === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = oldNode;
  }
});

test("personal API ignores supplied identity, rejects other tasks and never uses NFC completion as work completion", async () => {
  const queries: any[] = [];
  let staffActive = true;
  const sqlQueries: any[] = [];
  const db: any = {
    $queryRaw: async (query: any) => { sqlQueries.push(query); return query.sql.includes("SELECT DISTINCT") ? [{ id: "property", name: "Casa" }] : [{ id: "own" }]; },
    staffMember: { findUnique: async () => ({ id: "staff", dashboardUserId: "user", organizationId: "org", isActive: staffActive, fullName: "Maria", preferredLanguage: "es" }) },
    cleaningConfirmation: {
      findMany: async ({ where }: any) => { queries.push(where); return [{ id: "own", staffMemberId: "staff", propertyId: "property", reservationId: "reservation", status: "CONFIRMED" }]; },
      findFirst: async ({ where }: any) => where.id === "own" && where.staffMemberId === "staff" ? { id: "own", token: "private-offer", propertyId: "property", reservationId: "reservation" } : null,
    },
    reservation: {
      findMany: async ({ where }: any) => { queries.push(where); return [{ id: "reservation", propertyId: "property", status: "ACTIVE", checkOut: new Date(), property: { id: "property", name: "Casa", timezone: "America/Puerto_Rico" } }]; },
      findFirst: async () => ({ id: "reservation" }),
    },
    cleaningWork: { findMany: async () => [], findFirst: async () => null },
    staffAssignment: { findMany: async () => [{ reservationId: "reservation", startsAt: new Date(), endsAt: new Date(), status: "COMPLETED" }] },
  };
  const app = express();
  app.use(express.json());
  app.use(buildCleanerAccountRouter(db, (req: any, _res, next) => { req.user = { id: "user", orgId: "org", role: "CLEANER" }; next(); }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    const list = await fetch(`${base}/api/cleaner/cleanings?staffMemberId=other&organizationId=other`);
    assert.equal(list.status, 200);
    const body: any = await list.json();
    assert.equal(queries[0].staffMemberId, "staff");
    assert.equal(queries[1].property.organizationId, "org");
    assert.equal(body.items[0].status, "CONFIRMED");
    assert.equal(body.items[0].access.status, "COMPLETED");
    assert.equal(JSON.stringify(body).includes("private-offer"), false);
    assert.equal((await fetch(`${base}/api/cleaner/cleanings/other`)).status, 404);
    assert.equal((await fetch(`${base}/api/cleaner/cleanings/own`)).status, 200);
    assert.equal((await fetch(`${base}/api/staff/staff/cleaner-account`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "a@example.com" }) })).status, 403);
    for (const query of ["status=UNKNOWN", "from=2026-02-29", "from=2026-10-08&to=2026-10-07", "q=a&q=b", "view=today&view=history"]) {
      const invalid = await fetch(`${base}/api/cleaner/cleanings?${query}`);
      assert.equal(invalid.status, 400, query);
    }
    const properties = await fetch(`${base}/api/cleaner/cleaning-properties?staffMemberId=other&organizationId=other`);
    assert.equal(properties.status, 200);
    assert.equal(properties.headers.get("cache-control"), "no-store");
    assert.deepEqual(await properties.json(), { items: [{ id: "property", name: "Casa" }] });
    assert.deepEqual(sqlQueries.at(-1).values, ["staff", "org"]);
    for (const view of ["all", "overdue"]) assert.equal((await fetch(`${base}/api/cleaner/cleanings?view=${view}&propertyId=property`)).status, 200);
    staffActive = false;
    assert.equal((await fetch(`${base}/api/cleaner/cleaning-properties`)).status, 403);
    assert.equal((await fetch(`${base}/api/cleaner/cleanings`)).status, 403);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("global guard blocks legacy host routes and another cleaner's offer even with an old role claim", async () => {
  const previousCi = process.env.CI; const previousNode = process.env.NODE_ENV;
  process.env.CI = "true"; process.env.NODE_ENV = "test";
  const db: any = {
    dashboardUser: { findUnique: async () => ({ role: "CLEANER" }) },
    staffMember: { findUnique: async () => ({ id: "staff", dashboardUserId: "user", organizationId: "org", isActive: true }) },
    cleaningConfirmation: { findFirst: async ({ where }: any) => where.token === "own-offer" && where.staffMemberId === "staff" ? { propertyId: "property" } : null },
    property: { findFirst: async () => ({ id: "property" }) },
  };
  const app = express();
  app.use((req: any, _res, next) => { req.user = { id: "user", orgId: "org", role: "CLEANER" }; next(); });
  app.use(buildCleanerSurfaceGuard(db));
  app.get("/legacy-host-data", (_req, res) => res.json({ secret: true }));
  app.get("/cleaning/confirm/:token", (_req, res) => res.json({ own: true }));
  app.get("/api/public/brand-context", (_req, res) => res.json({ public: true }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const jwt = signAuthToken({ sub: "user", orgId: "org", email: "maria@example.com", role: "MEMBER", tokenVersion: 1 });
  const headers = { Authorization: `Bearer ${jwt}` };
  try {
    assert.equal((await fetch(`${base}/legacy-host-data`, { headers })).status, 403);
    assert.equal((await fetch(`${base}/cleaning/confirm/other-offer`, { headers })).status, 404);
    assert.equal((await fetch(`${base}/cleaning/confirm/own-offer`, { headers })).status, 200);
    assert.equal((await fetch(`${base}/api/public/brand-context`, { headers })).status, 200);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (previousCi === undefined) delete process.env.CI; else process.env.CI = previousCi;
    if (previousNode === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousNode;
  }
});


test("activation form preserves its same-origin POST and keeps token pages uncached", async () => {
  const staff = { id: "staff", organizationId: "org", fullName: "Maria", preferredLanguage: "es", isActive: true,
    dashboardUserId: null, cleanerAccountEmail: "maria@example.com", cleanerAccountRequestedAt: new Date("2026-01-01") };
  const db: any = {
    cleanerAccountActivation: { findUnique: async () => ({ staffMember: staff, staffMemberId: staff.id,
      email: staff.cleanerAccountEmail, requestedAt: staff.cleanerAccountRequestedAt, consumedAt: null,
      expiresAt: new Date(Date.now() + 60000), confirmationId: "confirmation" }) },
    cleaningConfirmation: { findFirst: async () => ({ id: "confirmation", reservationId: "reservation", propertyId: "property" }) },
    reservation: { findFirst: async () => ({ id: "reservation" }) },
    cleaningWork: { findFirst: async () => null },
  };
  const app = express();
  app.use(buildCleanerAccountRouter(db, (_req, _res, next) => next()));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as any).port}/cleaning/account/activate/${"a".repeat(48)}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("referrer-policy"), "same-origin");
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.match(await response.text(), /<form method="POST">/);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("public booking keeps its own access rules regardless of a cleaner cookie", async () => {
  let accountReads = 0;
  const db: any = { dashboardUser: { findUnique: async () => { accountReads++; throw new Error("No Dashboard lookup on public booking"); } } };
  const app = express();
  app.use(buildCleanerSurfaceGuard(db));
  app.get("/api/public-booking/discovery", (_req, res) => res.json({ public: true }));
  app.get("/api/public-booking/org/property", (_req, res) => res.json({ public: true }));
  app.post("/api/public-booking/quote", (_req, res) => res.json({ public: true }));
  // Token portals still enforce their independent guest authentication.
  app.get("/api/public-booking/manage/invalid", (_req, res) => res.status(404).json({ error: "INVALID_GUEST_TOKEN" }));
  app.get("/api/public-booking-admin", (_req, res) => res.json({ private: true }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const token = signAuthToken({ sub: "synthetic-cleaner", orgId: "org", email: "cleaner@example.com", role: "CLEANER", tokenVersion: 1 });
  const cookie = { Cookie: `${process.env.AUTH_COOKIE_NAME ?? "pingo_token"}=${token}` };
  try {
    const sessions: Record<string, string>[] = [{}, cookie, { Authorization: `Bearer ${token}` }, { Cookie: "pingo_token=expired" }];
    for (const headers of sessions) {
      for (const path of ["/api/public-booking/discovery", "/api/public-booking/org/property?preview=false"]) assert.equal((await fetch(`${base}${path}`, { headers })).status, 200);
      assert.equal((await fetch(`${base}/api/public-booking/quote`, { method: "POST", headers })).status, 200);
      const denied = await fetch(`${base}/api/public-booking/manage/invalid`, { headers });
      assert.equal(denied.status, 404);
      assert.deepEqual(await denied.json(), { error: "INVALID_GUEST_TOKEN" });
    }
    assert.equal(accountReads, 0);
    assert.equal((await fetch(`${base}/api/public-booking-admin`, { headers: cookie })).status, 503);
    assert.equal(accountReads, 1);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
