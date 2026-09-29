import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";

const source = await fs.readFile(new URL("./mobile-access-revocation-observer.service.ts", import.meta.url), "utf8");
const worker = await fs.readFile(new URL("../workers/reservation.worker.ts", import.meta.url), "utf8");

test("observer derives mobile revoke work from canonical persisted state", () => {
  assert.match(source, /endsAt: \{ lte: now \}/);
  assert.match(source, /accessGrant: \{ status: \{ in: \["REVOKED", "EXPIRED", "FAILED"\] \} \}/);
  assert.match(source, /reservation: \{ status: \{ in: \["CANCELLED", "COMPLETED"\] \} \}/);
});

test("observer is DB-only and bounded", () => {
  assert.doesNotMatch(source, /axios|TTLock|api\.sciener|\/v3\//i);
  assert.match(source, /Math\.min\(Math\.max\(limit, 1\), 100\)/);
});

test("Legacy reservation worker remains untouched by mobile observer", () => {
  assert.doesNotMatch(worker, /mobile-access-revocation-observer|findMobileAccessRevocationsDue/);
});
