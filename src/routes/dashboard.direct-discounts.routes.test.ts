import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { prisma } from "../lib/prisma";
import { directDiscountsRouter } from "./dashboard.direct-discounts.routes";
import { defaultDiscountConfig } from "../services/direct-booking-discounts.policy";

test("discount settings enforce tenant boundary, admin writes, validation and version conflicts", async t => {
  process.env.CI = "true"; process.env.NODE_ENV = "test";
  let user: object | null = { id: "u", orgId: "org1", role: "ORG_ADMIN" };
  let found = true;
  let writes = 0;
  const originalFind = prisma.property.findFirst;
  const originalCreate = prisma.directBookingDiscountConfig.create;
  const originalUpdate = prisma.directBookingDiscountConfig.updateMany;
  t.after(() => { prisma.property.findFirst = originalFind; prisma.directBookingDiscountConfig.create = originalCreate; prisma.directBookingDiscountConfig.updateMany = originalUpdate; });
  prisma.property.findFirst = (async (args: any) => {
    assert.equal(args.where.organizationId, "org1");
    return found ? { id: "p1", timezone: "America/Puerto_Rico", directDiscountConfig: null } : null;
  }) as any;
  prisma.directBookingDiscountConfig.create = (async (args: any) => { writes++; return { ...args.data, version: 1 }; }) as any;
  prisma.directBookingDiscountConfig.updateMany = (async () => ({ count: 0 })) as any;
  const app = express(); app.use(express.json()); app.use((req, _res, next) => { if (user) (req as any).user = user; next(); }); app.use(directDiscountsRouter);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address() as { port: number };
  const call = (method: string, body?: unknown) => fetch(`http://127.0.0.1:${address.port}/api/dashboard/properties/p1/direct-discounts`, {
    method, headers: { "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}),
  });
  try {
    assert.equal((await call("GET")).status, 200);
    found = false; assert.equal((await call("PUT", { config: defaultDiscountConfig, version: 0 })).status, 404); found = true;
    user = { id: "u", orgId: "org1", role: "MEMBER" };
    assert.equal((await call("PUT", { config: defaultDiscountConfig, version: 0 })).status, 403);
    user = { id: "u", orgId: "org1", role: "ORG_ADMIN" };
    assert.equal((await call("PUT", { config: { ...defaultDiscountConfig, maxDiscountPercent: 101 }, version: 0 })).status, 400);
    assert.equal(writes, 0);
    assert.equal((await call("PUT", { config: defaultDiscountConfig, version: 0 })).status, 200);
    assert.equal(writes, 1);
    assert.equal((await call("PUT", { config: defaultDiscountConfig, version: 1 })).status, 409);
    user = null; assert.equal((await call("GET")).status, 401);
  } finally { await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve())); }
});
