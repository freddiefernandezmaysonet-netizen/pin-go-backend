import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import express from "express";
import type { PrismaClient } from "@prisma/client";
import { damagePaymentAuthorizationRouter } from "./public-booking.damage-payment-authorization.routes.js";

test("HTTP authorization boundary: errors, no-store and sanitized failures", async t => {
  const prisma = {
    reservation: { findUnique: async ({ where }: { where: { guestToken: string } }) => {
      if (where.guestToken === "internal-error") throw new Error("Sensitive SQL and token must not appear");
      return null;
    } },
  } as unknown as PrismaClient;
  const app = express();
  app.use(express.json());
  app.use("/public-booking", damagePaymentAuthorizationRouter(prisma));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/public-booking/manage`;
  const path = "/property-protection-case/payment-authorization";
  for (const [token, status, code] of [
    ["missing", 404, "RESERVATION_NOT_FOUND"], ["internal-error", 500, "PAYMENT_AUTHORIZATION_UNAVAILABLE"],
  ] as const) {
    const res = await fetch(`${base}/${token}${path}`);
    assert.equal(res.status, status);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(res.headers.get("referrer-policy"), "no-referrer");
    assert.deepEqual(await res.json(), { ok: false, error: code });
  }
  const response = await fetch(`${base}/synthetic${path}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "ACCEPTED" }),
  });
  assert.equal(response.status, 400);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { ok: false, error: "INVALID_AUTHORIZATION" });
});
