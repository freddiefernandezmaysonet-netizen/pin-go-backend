import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

async function readDashboardReservationsRoute() {
  return readFile(
    new URL("../routes/dashboard.reservations.route.ts", import.meta.url),
    "utf8"
  );
}

function getManualCancellationRoute(source: string) {
  const routeStart = source.indexOf(
    '"/api/dashboard/reservations/:id/cancel-manual"'
  );
  const refundRouteStart = source.indexOf(
    '"/api/dashboard/reservations/:id/refund"',
    routeStart
  );

  assert.notEqual(routeStart, -1);
  assert.notEqual(refundRouteStart, -1);
  assert.ok(routeStart < refundRouteStart);

  return source.slice(routeStart, refundRouteStart);
}

test("manual cancellation route is authenticated", async () => {
  const source = await readDashboardReservationsRoute();
  const route = getManualCancellationRoute(source);

  assert.match(route, /requireAuth/);
});

test("manual cancellation route derives organization and user from the authenticated session", async () => {
  const source = await readDashboardReservationsRoute();
  const route = getManualCancellationRoute(source);

  assert.match(
    route,
    /organizationId\s*=\s*String\(user\.orgId/
  );
  assert.match(
    route,
    /user\.id\s*\?\?\s*user\.userId/
  );
  assert.match(
    route,
    /AUTHENTICATED_USER_ID_REQUIRED/
  );
  assert.doesNotMatch(route, /req\.body\?\.organizationId/);
  assert.doesNotMatch(route, /req\.body\?\.requestedByUserId/);
});

test("manual cancellation route delegates reason and identity to the canonical service", async () => {
  const source = await readDashboardReservationsRoute();
  const route = getManualCancellationRoute(source);

  assert.match(
    route,
    /typeof req\.body\?\.reason === "string"/
  );
  assert.match(
    route,
    /cancelManualReservationByHost\(\{[\s\S]*?organizationId,[\s\S]*?reservationId,[\s\S]*?reason,[\s\S]*?requestedByUserId/
  );
});

test("manual cancellation route maps domain errors without implementing cancellation logic", async () => {
  const source = await readDashboardReservationsRoute();
  const route = getManualCancellationRoute(source);

  assert.match(
    route,
    /ManualReservationCancellationError/
  );
  assert.match(
    route,
    /error\?\.statusCode \|\| 400/
  );
  assert.match(
    route,
    /MANUAL_RESERVATION_CANCELLATION_ERROR/
  );

  assert.doesNotMatch(route, /prisma\./);
  assert.doesNotMatch(route, /ReservationStatus\.CANCELLED/);
  assert.doesNotMatch(route, /refundDirectBookingReservation/);
  assert.doesNotMatch(route, /stripe/i);
  assert.doesNotMatch(route, /ttlock/i);
  assert.doesNotMatch(route, /cleaningConfirmation/);
  assert.doesNotMatch(route, /accessGrant/);
});
