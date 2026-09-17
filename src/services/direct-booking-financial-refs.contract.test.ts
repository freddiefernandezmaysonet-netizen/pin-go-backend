import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const source = fs.readFileSync(
  path.resolve(process.cwd(), "src/services/direct-booking.service.ts"),
  "utf8"
);

test("Direct Booking financial refs select connected-account context only for Direct Charges", () => {
  assert.match(
    source,
    /stripeChargeMode\s*===\s*"DIRECT_CHARGE"\s*&&\s*stripeConnectedAccountId[\s\S]*\?\s*stripeConnectedAccountId\s*:\s*undefined/
  );
  assert.match(
    source,
    /stripeAccount\s*\?\s*\{\s*stripeAccount\s*\}\s*:\s*undefined/
  );
});

test("Destination Charge financial refs preserve platform context", () => {
  assert.match(
    source,
    /stripeChargeMode\s*===\s*"DIRECT_CHARGE"[\s\S]*:\s*undefined/
  );
});
