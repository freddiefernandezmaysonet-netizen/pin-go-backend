import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

async function readRoute(name: string) {
  return readFile(
    new URL(`../routes/${name}`, import.meta.url),
    "utf8"
  );
}

test("checkouts today uses the same active UTC window in metrics and reservations", async () => {
  const [metricsSource, reservationsSource] = await Promise.all([
    readRoute("dashboard.metrics.route.ts"),
    readRoute("dashboard.reservations.route.ts"),
  ]);

  assert.match(
    metricsSource,
    /status:\s*ReservationStatus\.ACTIVE,[\s\S]*checkOut:\s*\{\s*gte:\s*start,\s*lt:\s*end\s*\}/
  );
  assert.match(
    reservationsSource,
    /operationalStatusQ === "CHECKOUTS_TODAY"/
  );
  assert.match(
    reservationsSource,
    /operationalStatus === "CHECKOUTS_TODAY"[\s\S]*where\.checkOut = \{ gte: start, lt: end \}/
  );
  assert.match(
    reservationsSource,
    /where:\s*any = \{\s*property:\s*\{ organizationId: orgId \}/
  );
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
