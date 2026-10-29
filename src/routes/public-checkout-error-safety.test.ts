import assert from "node:assert/strict";
import test from "node:test";
import express from "express";

process.env.STRIPE_SECRET_KEY ??= "sk_test_fixture_not_a_real_key";
process.env.STRIPE_PRICE_PLATFORM_MONTHLY = "price_fixture";

test("guest and signup checkout failures never return or log provider secrets", async t => {
  const { default: booking, publicBookingDb } = await import("./public-booking.routes.js");
  const { default: signup } = await import("./public.signup.routes.js");
  const { default: stripe } = await import("../billing/stripe.js");
  const secret = "synthetic-secret-MUST-NOT-LEAK";
  const providerError = Object.assign(new Error(`Invalid API key: ${secret}`), {
    type: "StripeAuthenticationError", requestId: secret, raw: { message: secret },
  });
  const logs: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => { logs.push(args); });
  const original = publicBookingDb.property.findFirst;
  publicBookingDb.property.findFirst = (async () => { throw providerError; }) as typeof original;
  t.after(() => { publicBookingDb.property.findFirst = original; });
  t.mock.method(stripe.prices, "retrieve", async () => { throw providerError; });
  const app = express(); app.use(express.json());
  app.use("/api/public-booking", booking); app.use(signup);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const cases = [
    { path: "/api/public-booking/create-checkout", body: {
      propertyId: "synthetic-property", checkIn: "2030-01-02", checkOut: "2030-01-04",
      guestName: "Test Guest", guestEmail: "guest@example.test", adults: 1, children: 0,
      guestAcceptedCancellationTerms: true, guestAcceptedSecurePreCheckinRequirement: true,
    }, expected: "Failed to create checkout" },
    { path: "/api/public/signup-checkout", body: {
      plan: "platform", organizationName: "Rental Demo", fullName: "Test Host",
      email: "host@example.test", password: "Jade!Clouds7Fence", locks: 1,
    }, expected: "Unable to start signup checkout" },
  ];
  for (const item of cases) {
    const response = await fetch(origin + item.path, { method: "POST",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify(item.body) });
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { ok: false, error: item.expected });
  }
  assert.equal(logs.length, 2);
  assert.equal(JSON.stringify(logs).includes(secret), false);
  assert.equal(JSON.stringify(logs).includes("StripeAuthenticationError"), false);
});
