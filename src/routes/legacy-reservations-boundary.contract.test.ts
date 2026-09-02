import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const serverSource = readFileSync(
  new URL("../server.ts", import.meta.url),
  "utf8"
);

test("legacy reservation routers are not reachable from the application", () => {
  assert.doesNotMatch(
    serverSource,
    /routes\/reservations\.routes|\breservationsRouter\b|app\.use\(\s*["']\/reservations["']/
  );
  assert.doesNotMatch(
    serverSource,
    /routes\/cleaning\.routes|\bbuildCleaningRouter\b/
  );
});

test("the authenticated dashboard reservation boundary remains mounted", () => {
  assert.match(
    serverSource,
    /import \{ dashboardReservationsRouter \} from "\.\/routes\/dashboard\.reservations\.route"/
  );
  assert.match(serverSource, /app\.use\(dashboardReservationsRouter\)/);
});
