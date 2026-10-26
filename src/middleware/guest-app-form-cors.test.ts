import test from "node:test";
import assert from "node:assert/strict";
import express, { type RequestHandler } from "express";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { withGuestAppFormCors } from "./guest-app-form-cors.js";
import { buildGuestAppRouter } from "../routes/guest-app.routes.js";
import type { PrismaClient } from "@prisma/client";

const cors = createRequire(import.meta.url)("cors") as (options: {
  origin: (origin: string | undefined, callback: (error: Error | null, allowed?: boolean) => void) => void;
}) => RequestHandler;

test("Origin null activation forms reach their CSRF guard; JSON, preflights and other routes retain CORS", async t => {
  const app = express(); let guardedLookups = 0;
  app.use(withGuestAppFormCors(cors({ origin(origin, callback) {
    callback(origin && origin !== "https://app.pin-ngo.com" ? Error("Rejected CORS origin") : null, true);
  } })));
  app.use(express.urlencoded({ extended: false }));
  app.use(buildGuestAppRouter({ reservation: { findFirst: async () => { guardedLookups++; return null; } } } as unknown as PrismaClient));
  app.use((_req, res) => res.status(204).end());
  app.use(((error, _req, res, _next) => res.status(500).send(error.message)) as express.ErrorRequestHandler);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const path = "/guest/app/synthetic_private_activation_token_123456";
  const post = (suffix: string, extra: Record<string, string> = {}) => fetch(base + suffix, {
    method: "POST", headers: { Origin: "null", "Content-Type": "application/x-www-form-urlencoded", ...extra }, body: "csrf=synthetic",
  });
  for (const action of ["request", "verify"]) {
    const response = await post(`${path}/${action}`);
    assert.equal(response.status, 403, "missing CSRF cookie is rejected by activation, not a CORS 500");
    assert.equal(response.headers.get("access-control-allow-origin"), null);
    assert.match(response.headers.get("cache-control")!, /no-store/);
  }
  const secret = "s".repeat(43);
  const crossSite = await fetch(base + path + "/request", { method: "POST", headers: {
    Origin: "null", "Content-Type": "application/x-www-form-urlencoded", "Sec-Fetch-Site": "cross-site",
    Cookie: `__Host-pingo-guest-activation=${secret}`,
  }, body: new URLSearchParams({ csrf: secret }) });
  assert.equal(crossSite.status, 403);
  assert.equal(guardedLookups, 0, "unverified forms cannot query the stay or send a code");
  assert.equal((await post(path + "/request", { "Content-Type": "application/json" })).status, 500);
  assert.equal((await post("/api/guest-mobile/session/exchange")).status, 500);
  assert.equal((await post("/api/dashboard/reservations")).status, 500);
  assert.equal((await post(path + "/request/extra")).status, 500);
  assert.equal((await fetch(base + path + "/request", { method: "OPTIONS", headers: { Origin: "null" } })).status, 500);
  const normal = await fetch(base + "/api/example", { headers: { Origin: "https://app.pin-ngo.com" } });
  assert.equal(normal.status, 204);
  assert.equal(normal.headers.get("access-control-allow-origin"), "https://app.pin-ngo.com");
});
