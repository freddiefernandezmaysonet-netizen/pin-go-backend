import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const routeSource = readFileSync(
  new URL("./dashboard.damage-cases.routes.ts", import.meta.url),
  "utf8"
);
const serverSource = readFileSync(
  new URL("../server.ts", import.meta.url),
  "utf8"
);

test("Damage Case API is authenticated and organization-scoped", () => {
  assert.match(routeSource, /requireAuth/);
  assert.match(routeSource, /organizationId: auth\.orgId/);
  assert.doesNotMatch(routeSource, /findUnique\(\{[\s\S]*reservationId/);
});

test("creation reuses the certified immutable reservation policy guard", () => {
  assert.match(routeSource, /evaluateDamageCasePolicy/);
  assert.match(routeSource, /propertyProtectionRequiredSnapshot: true/);
  assert.match(routeSource, /maxDamageLiabilityAmountSnapshot: true/);
  assert.match(routeSource, /damagePaymentMethodStatus: true/);
  assert.match(routeSource, /stripeDamageCustomerId: true/);
  assert.match(routeSource, /stripeDamagePaymentMethodId: true/);
  assert.match(routeSource, /DAMAGE_CASE_ALREADY_EXISTS/);
});

test("review requires evidence and approval stops at guest notification pending", () => {
  assert.match(routeSource, /DAMAGE_EVIDENCE_REQUIRED/);
  assert.match(routeSource, /DamageCaseStatus\.HOST_REVIEW/);
  assert.match(routeSource, /DamageCaseStatus\.GUEST_NOTIFICATION_PENDING/);
  assert.doesNotMatch(routeSource, /DamageCaseStatus\.GUEST_NOTIFIED/);
  assert.doesNotMatch(routeSource, /DamageCaseStatus\.CHARGE_BLOCKED/);
});

test("API has an explicit no-charge close path", () => {
  assert.match(routeSource, /close-no-charge/);
  assert.match(routeSource, /DamageCaseStatus\.CLOSED_NO_CHARGE/);
  assert.match(routeSource, /DAMAGE_CASE_CLOSE_REASON_REQUIRED/);
});

test("Damage Case API contains no Stripe financial mutation", () => {
  assert.doesNotMatch(routeSource, /from ["']\.\.\/billing\/stripe/);
  assert.doesNotMatch(routeSource, /paymentIntents\./);
  assert.doesNotMatch(routeSource, /charges\./);
  assert.doesNotMatch(routeSource, /refunds\./);
  assert.doesNotMatch(routeSource, /capture_method/);
  assert.doesNotMatch(routeSource, /stripeDamagePaymentMethodId\s*:/);
});

test("server registers the Damage Case dashboard router", () => {
  assert.match(serverSource, /buildDashboardDamageCasesRouter/);
  assert.match(serverSource, /app\.use\(buildDashboardDamageCasesRouter\(prisma\)\)/);
});
