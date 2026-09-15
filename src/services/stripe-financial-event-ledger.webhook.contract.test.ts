import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const webhook = readFileSync(
  "src/webhooks/stripe.webhook.ts",
  "utf8"
);

test("Stripe webhook claims financial events only after signature verification", () => {
  const constructIndex = webhook.indexOf(
    "stripe.webhooks.constructEvent"
  );
  const claimIndex = webhook.indexOf(
    "ledgerClaim = await claimStripeFinancialEvent"
  );

  assert.ok(constructIndex >= 0);
  assert.ok(claimIndex > constructIndex);
});

test("Stripe webhook acknowledges ledger duplicates without executing handlers", () => {
  assert.match(
    webhook,
    /if \(!ledgerClaim\.shouldProcess\)/
  );
  assert.match(
    webhook,
    /duplicate:\s*true/
  );
  assert.match(
    webhook,
    /ledgerReason:\s*ledgerClaim\.reason/
  );
});

test("Stripe webhook marks tracked events processed after current handler flow", () => {
  assert.match(
    webhook,
    /markStripeFinancialEventProcessed/
  );
  const switchIndex = webhook.indexOf("switch (event.type)");
  const processedCallIndex = webhook.lastIndexOf(
    "markStripeFinancialEventProcessed"
  );

  assert.ok(switchIndex >= 0);
  assert.ok(processedCallIndex > switchIndex);
});

test("Stripe webhook marks tracked events failed before returning 500", () => {
  const failedCallIndex = webhook.lastIndexOf(
    "markStripeFinancialEventFailed"
  );
  const errorResponseIndex = webhook.lastIndexOf(
    "res.status(500).json"
  );

  assert.ok(failedCallIndex >= 0);
  assert.ok(errorResponseIndex > failedCallIndex);
});
