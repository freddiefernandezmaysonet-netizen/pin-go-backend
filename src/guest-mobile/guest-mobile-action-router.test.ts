import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import express from "express";
import type { PrismaClient } from "@prisma/client";
import { buildGuestMobileActionRouter } from "./guest-mobile-action-router.js";

test("mobile actions require live device identity and delegate only scoped confirm/status", async () => {
  const bearer = "fixture_device_token_123456789", proposal = "proposal_fixture_01";
  let revoked = false, expired = false, tokenExpired = false, unavailable = false;
  let delegated = 0;
  const prisma = {
    guestDeviceSession: { findUnique: async ({ where }: any) => where.tokenHash === createHash("sha256").update(bearer).digest("hex")
      ? { id: "device", guestPersonId: "person", revokedAt: revoked ? new Date() : null, expiresAt: new Date(Date.now() + (expired ? -60_000 : 60_000)) } : null },
    guestStayLink: { findFirst: async ({ where }: any) => {
      assert.equal(where.guestPersonId, "person"); assert.equal(where.revokedAt, null);
      assert.equal(where.reservation.status, "ACTIVE"); assert.equal(where.reservation.property.status, "ACTIVE");
      if (unavailable || where.reservation.reservationNumber !== "PG_TEST") return null;
      return { reservation: { id: "reservation", propertyId: "property", guestToken: "fixture_stay_token_12345678",
        guestTokenExpiresAt: new Date(Date.now() + (tokenExpired ? -60_000 : 60_000)), property: { organizationId: "organization" } } };
    } },
  } as unknown as PrismaClient;
  const canonical = express.Router();
  canonical.post("/manage/:guestToken/pin-ai/action-proposals/:proposalId/confirm", (req, res) => {
    delegated++; assert.equal(req.params.guestToken, "fixture_stay_token_12345678");
    assert.equal(req.params.proposalId, proposal);
    assert.deepEqual(req.body, { confirmationToken: "fixture_confirmation" });
    res.json({ ok: true, action: { proposalId: proposal, outcome: "EXECUTED" } });
  });
  canonical.get("/manage/:guestToken/pin-ai/action-proposals/:proposalId/status", (req, res) => {
    delegated++; res.json({ ok: true, status: { proposalId: req.params.proposalId, proposalStatus: "PENDING_CONFIRMATION" } });
  });
  const app = express(); app.use(express.json()); app.use(buildGuestMobileActionRouter({ prisma, actions: canonical }));
  const server = app.listen(0, "127.0.0.1"); await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const request = (stay = "PG_TEST", action = "status", token: string | null = bearer, method = "GET") => fetch(
    `${origin}/api/guest-mobile/stays/${stay}/pin-ai/action-proposals/${proposal}/${action}`, {
      method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(method === "POST" ? { body: JSON.stringify({ confirmationToken: "fixture_confirmation" }) } : {}),
    });
  try {
    assert.equal((await request("PG_TEST", "status", null)).status, 401);
    assert.equal((await request("PG_TEST", "status", "wrong_device_token_12345678")).status, 401);
    revoked = true; assert.equal((await request()).status, 401); revoked = false;
    expired = true; assert.equal((await request()).status, 401); expired = false;
    assert.equal((await request("PG_OTHER")).status, 404);
    tokenExpired = true; assert.equal((await request()).status, 404); tokenExpired = false;
    unavailable = true; assert.equal((await request()).status, 404); unavailable = false;
    assert.equal((await request("PG_TEST", "confirm")).status, 404);
    assert.equal((await request("PG_TEST", "execute", bearer, "POST")).status, 404);
    assert.equal(delegated, 0);
    const status = await request(); assert.equal(status.status, 200);
    assert.match(status.headers.get("cache-control") ?? "", /no-store/);
    assert.equal((await status.json() as any).status.proposalId, proposal);
    const confirmed = await request("PG_TEST", "confirm", bearer, "POST");
    assert.equal(confirmed.status, 200); assert.equal((await confirmed.json() as any).action.outcome, "EXECUTED");
    assert.equal(delegated, 2);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
