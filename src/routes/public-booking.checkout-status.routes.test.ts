import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import type { PrismaClient } from "@prisma/client";
import { buildCheckoutStatusRouter } from "./public-booking.checkout-status.routes.js";

test("checkout state waits for the paid reservation and never exposes private booking data", async t => {
  let record: unknown = null;
  let reads = 0;
  let fail = false;
  const db = { reservation: { findUnique: async ({ where, select }: { where: unknown; select: Record<string, unknown> }) => {
    reads++; assert.deepEqual(where, { stripeCheckoutSessionId: "cs_test_synthetic_123456" });
    for (const key of ["guestEmail", "guestName", "guestToken", "reservationNumber", "stripePaymentIntentId"]) assert.equal(select[key], undefined);
    if (fail) throw new Error("synthetic database secret");
    return record;
  } }, property: { findFirst: async () => ({ pinAIEnabled: true, pinAIFeeExempt: true,
    pinAITermsVersion: "pin-ai-connect-usd-1-reservation-v1", organization: { pinAIRevision: 1, pinAIEnabled: true } }) } } as unknown as Pick<PrismaClient, "reservation" | "property">;
  const app = express(); app.use(buildCheckoutStatusRouter(db, {
    PIN_AI_GUEST_GATEWAY_ENABLED: "true", PIN_AI_PROPERTY_ACTIVATION_ENABLED: "true",
  }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/checkout-status`;
  for (const query of ["", "?session_id=invalid", "?session_id[]=cs_test_synthetic_123456"]) {
    assert.equal((await fetch(base + query)).status, 400);
  }
  assert.equal(reads, 0);
  async function read() {
    const response = await fetch(base + "?session_id=cs_test_synthetic_123456");
    assert.equal(response.headers.get("cache-control"), "no-store");
    return { code: response.status, body: await response.json() };
  }
  assert.deepEqual((await read()).body, { ok: true, status: "PENDING" });
  const paid = { source: "DIRECT_BOOKING", externalProvider: "PIN_GO_DIRECT", status: "ACTIVE", paymentState: "PAID",
    identityVerificationRequiredSnapshot: false, property: { id: "p", organizationId: "o", slug: "house", organization: { slug: "org" } } };
  record = { ...paid, paymentState: "PENDING" };
  assert.equal((await read()).body.status, "PENDING");
  record = paid;
  assert.deepEqual((await read()).body, { ok: true, status: "CONFIRMED", identityVerificationRequired: false,
    organizationSlug: "org", propertySlug: "house", pinAIEnabled: true });
  record = { ...paid, status: "CANCELLED" };
  assert.deepEqual((await read()).body, { ok: true, status: "UNAVAILABLE" });
  record = { ...paid, source: "OTA", externalProvider: "CHANNEX" };
  assert.deepEqual((await read()).body, { ok: true, status: "PENDING" });
  fail = true;
  assert.deepEqual(await read(), { code: 503, body: { ok: false, error: "CHECKOUT_STATUS_UNAVAILABLE" } });
});
