import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("dashboard exposes authenticated date-only manual reservation change contract", async () => {
  const source = await readFile(
    new URL("./dashboard.manual-reservation-date-change.route.ts", import.meta.url),
    "utf8"
  );

  assert.match(source, /\/api\/dashboard\/reservations\/:id\/dates/);
  assert.match(source, /requireAuth/);
  assert.match(source, /checkInDate/);
  assert.match(source, /checkOutDate/);
  assert.match(source, /changeManualReservationDatesByHost/);
});

test("manual reservation date change router is mounted by the canonical dashboard router", async () => {
  const source = await readFile(new URL("./dashboard.route.ts", import.meta.url), "utf8");
  assert.match(source, /dashboardManualReservationDateChangeRouter/);
  assert.match(source, /dashboardRouter\.use\(dashboardManualReservationDateChangeRouter\)/);
});
