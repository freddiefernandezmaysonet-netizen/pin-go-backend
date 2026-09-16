import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const serviceSource = fs.readFileSync(
  new URL("./stripe-connect-dashboard-link.service.ts", import.meta.url),
  "utf8"
);

const routeSource = fs.readFileSync(
  new URL("../routes/dashboard-payouts.routes.ts", import.meta.url),
  "utf8"
);

test("Stripe Express dashboard login link is scoped to the authenticated organization", () => {
  assert.match(
    routeSource,
    /const organizationId = getOrgIdFromRequest\(req\);[\s\S]*?createConnectDashboardLoginLink\([\s\S]*?organizationId[\s\S]*?\)/
  );
  assert.match(
    routeSource,
    /const orgId = req\.user\?\.orgId;/
  );
  assert.doesNotMatch(
    routeSource,
    /createConnectDashboardLoginLink\([\s\S]*?req\.(body|query|params)/
  );
});

test("Stripe Express dashboard login link uses the persisted Connect account", () => {
  assert.match(
    serviceSource,
    /stripeConnectAccountId: true/
  );
  assert.match(
    serviceSource,
    /getStripeClient\(\)\.accounts\.createLoginLink\([\s\S]*?accountId[\s\S]*?\)/
  );
  assert.doesNotMatch(
    serviceSource,
    /req\.(body|query|params)/
  );
});

test("Stripe Express dashboard login link fails closed before onboarding is complete", () => {
  assert.match(
    serviceSource,
    /STRIPE_CONNECT_NOT_CONNECTED/
  );
  assert.match(
    serviceSource,
    /STRIPE_CONNECT_ONBOARDING_INCOMPLETE/
  );
  assert.match(
    serviceSource,
    /stripeConnectDetailsSubmitted/
  );
});
