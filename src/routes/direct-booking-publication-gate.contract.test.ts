import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const source = fs.readFileSync(
  path.resolve(process.cwd(), "src/routes/dashboard.properties.route.ts"),
  "utf8"
);

test("publishing Direct Booking requires Stripe Connect payout readiness", () => {
  assert.match(
    source,
    /isPublicBookable\s*===\s*true[\s\S]*existing\.isPublicBookable\s*!==\s*true[\s\S]*assertDirectBookingPayoutReady\(orgId\)/
  );
});

test("property update reads existing publication state before applying the gate", () => {
  assert.match(
    source,
    /select:\s*\{[\s\S]*isPublicBookable:\s*true/
  );
});

test("unpublishing does not require Stripe Connect readiness", () => {
  assert.doesNotMatch(
    source,
    /isPublicBookable\s*===\s*false[\s\S]{0,500}assertDirectBookingPayoutReady/
  );
});

test("publication readiness failure returns conflict instead of publishing", () => {
  assert.match(source, /HOST_PAYOUT_NOT_READY/);
  assert.match(source, /res\.status\(409\)/);
});
