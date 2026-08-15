import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

async function readDashboardPropertiesRoute() {
  return readFile(
    new URL("../routes/dashboard.properties.route.ts", import.meta.url),
    "utf8"
  );
}

function getManualReservationRoute(source: string) {
  const routeStart = source.indexOf(
    '"/api/dashboard/properties/:id/manual-reservations"'
  );
  const nextRouteStart = source.indexOf(
    'dashboardPropertiesRouter.',
    routeStart + 1
  );

  assert.notEqual(routeStart, -1);
  assert.notEqual(nextRouteStart, -1);

  return source.slice(routeStart, nextRouteStart);
}

test("manual reservation pricing snapshot persists the Pricing Engine nightly rate", async () => {
  const source = await readDashboardPropertiesRoute();
  const route = getManualReservationRoute(source);

  assert.match(route, /calculateDirectBookingPricing\(\{/);
  assert.match(
    route,
    /nightlyRate:\s*\(manualPricing as any\)\.nightlyRate \?\? null/
  );
  assert.match(
    route,
    /nightlyRates:\s*\(manualPricing as any\)\.nightlyRates \?\? \[\]/
  );
  assert.match(
    route,
    /nightlySubtotal:\s*\(manualPricing as any\)\.nightlySubtotal \?\? null/
  );
});

test("manual reservation stores the complete canonical pricing snapshot", async () => {
  const source = await readDashboardPropertiesRoute();
  const route = getManualReservationRoute(source);

  assert.match(
    route,
    /pricingBreakdown:\s*manualPricingBreakdown/
  );
  assert.doesNotMatch(
    route,
    /nightlyRate:\s*manualTotalAmount/
  );
});
