import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const routePath = path.resolve(process.cwd(), "src/routes/public-booking.routes.ts");
const stripePath = path.resolve(process.cwd(), "src/billing/stripe.ts");
const routeSource = fs.readFileSync(routePath, "utf8");
const stripeSource = fs.readFileSync(stripePath, "utf8");

test("initial Direct Booking preserves payout evidence before Stripe Session normalization", () => {
  const checkoutStart = routeSource.indexOf('publicBookingRouter.post("/create-checkout"');
  assert.notEqual(checkoutStart, -1);
  const checkoutSource = routeSource.slice(checkoutStart);

  assert.match(checkoutSource, /hostPayoutStatus:\s*"ROUTED_TO_CONNECT"/);
  assert.match(checkoutSource, /stripeConnectedAccountId:\s*connectedAccountId/);
});

test("Stripe Session normalization removes redundant hostPayoutStatus before adding stripeChargeMode", () => {
  assert.match(
    stripeSource,
    /hostPayoutStatus:\s*_derivedHostPayoutStatus[\s\S]*\.\.\.checkoutSessionMetadata/
  );
  assert.match(
    stripeSource,
    /metadata:\s*\{[\s\S]*\.\.\.checkoutSessionMetadata,[\s\S]*stripeChargeMode:\s*checkoutContext\.chargeMode/
  );
});

test("Direct Charges keeps stripeChargeMode as canonical financial routing evidence", () => {
  assert.match(stripeSource, /stripeChargeMode:\s*checkoutContext\.chargeMode/);
});
