import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const source = fs.readFileSync(
  path.resolve(process.cwd(), "src/services/direct-booking.service.ts"),
  "utf8"
);

test("Direct Booking financial refs require Direct Charge context", () => {
  assert.match(
    source,
    /stripeChargeMode\s*!==\s*"DIRECT_CHARGE"[\s\S]*DIRECT_BOOKING_STRIPE_CHARGE_MODE_INVALID/
  );
  assert.match(
    source,
    /stripeConnectedAccountId[\s\S]*startsWith\("acct_"\)[\s\S]*DIRECT_BOOKING_STRIPE_CONNECTED_ACCOUNT_INVALID/
  );
});

test("Direct Booking financial refs always read PaymentIntent in the connected account", () => {
  assert.match(
    source,
    /stripe\.paymentIntents\.retrieve\([\s\S]*\{\s*stripeAccount:\s*stripeConnectedAccountId!\s*\}/
  );
  assert.doesNotMatch(
    source,
    /stripeAccount\s*\?\s*\{\s*stripeAccount\s*\}\s*:\s*undefined/
  );
  assert.doesNotMatch(source, /latest_charge\.transfer/);
});
