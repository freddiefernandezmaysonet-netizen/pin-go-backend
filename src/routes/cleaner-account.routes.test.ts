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
  const db: any = {
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
    staffActive = false;
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
