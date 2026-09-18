import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const stripeClientSource = fs.readFileSync(
  path.resolve(process.cwd(), "src/billing/stripe.ts"),
  "utf8"
);

const stripeWebhookSource = fs.readFileSync(
  path.resolve(process.cwd(), "src/webhooks/stripe.webhook.ts"),
  "utf8"
);

test("production Stripe client never logs secret-key diagnostics", () => {
  assert.doesNotMatch(stripeClientSource, /STRIPE KEY CHECK/);
  assert.doesNotMatch(stripeClientSource, /key\.slice\s*\(/);
});

test("checkout webhook never dumps complete Stripe session metadata", () => {
  assert.doesNotMatch(
    stripeWebhookSource,
    /metadata\s*:\s*session\.metadata/
  );
  assert.doesNotMatch(
    stripeWebhookSource,
    /guest(?:Email|Phone|Name)\s*:\s*session\.metadata/
  );
});
