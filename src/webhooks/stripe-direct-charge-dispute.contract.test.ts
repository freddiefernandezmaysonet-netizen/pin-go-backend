import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const source = fs.readFileSync(
  path.resolve(process.cwd(), "src/webhooks/stripe.webhook.ts"),
  "utf8"
);

test("Stripe webhook wires the three Direct Charge dispute lifecycle events", () => {
  assert.match(source, /case "charge\.dispute\.created":/);
  assert.match(source, /case "charge\.dispute\.updated":/);
  assert.match(source, /case "charge\.dispute\.closed":/);
  assert.match(source, /syncStripeDirectChargeDispute\(prisma, event\)/);
});

test("dispute webhook wiring delegates financial decisions to the fenced service", () => {
  assert.doesNotMatch(
    source,
    /case "charge\.dispute\.(?:created|updated|closed)"[\s\S]{0,1200}stripe\.(?:refunds|charges|paymentIntents)\./
  );
});
