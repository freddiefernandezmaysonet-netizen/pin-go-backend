import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

async function readRoute(name: string) {
  return readFile(
    new URL(`../routes/${name}`, import.meta.url),
    "utf8"
  );
}

test("today metrics and checkout filters use each property timezone", async () => {
  const [overviewSource, metricsSource, reservationsSource] = await Promise.all([
    readRoute("dashboard.route.ts"),
    readRoute("dashboard.metrics.route.ts"),
    readRoute("dashboard.reservations.route.ts"),
  ]);

  for (const source of [overviewSource, metricsSource, reservationsSource]) {
    assert.match(source, /formatInTimeZone/);
    assert.match(source, /fromZonedTime/);
    assert.doesNotMatch(source, /startEndOfTodayUTC/);
  }

  assert.match(metricsSource, /propertyId[\s\S]*checkOut:\s*\{\s*gte:\s*start,\s*lt:\s*end/);
  assert.match(reservationsSource, /operationalStatusQ === "CHECKOUTS_TODAY"/);
  assert.match(reservationsSource, /property\.timezone/);
  assert.match(overviewSource, /checkInTodayWhere/);
  assert.match(overviewSource, /checkOutTodayWhere/);
});

test("upcoming and in-house deep links remain supported by reservations", async () => {
  const source = await readRoute("dashboard.reservations.route.ts");

  assert.match(source, /operationalStatusQ === "UPCOMING"/);
  assert.match(source, /operationalStatusQ === "IN_HOUSE"/);
  assert.match(
    source,
    /operationalStatus === "UPCOMING"[\s\S]*where\.checkIn = \{ gt: now \}/
  );
  assert.match(
    source,
    /operationalStatus === "IN_HOUSE"[\s\S]*where\.checkIn = \{ lte: now \}[\s\S]*where\.checkOut = \{ gt: now \}/
  );
});
