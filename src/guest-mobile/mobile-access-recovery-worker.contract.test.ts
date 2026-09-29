import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";

const worker = await fs.readFile(new URL("../workers/mobile-access-recovery.worker.ts", import.meta.url), "utf8");
const pkg = await fs.readFile(new URL("../../package.json", import.meta.url), "utf8");
const railway = await fs.readFile(new URL("../../railway.json", import.meta.url), "utf8").catch(() => "");

test("recovery worker queries DB-driven due work and never polls TTLock directly", () => {
  assert.match(worker, /runDueMobileAccessRecovery/);
  assert.doesNotMatch(worker, /axios|TTLockMobileAccessProvider|api\.sciener|\/v3\//i);
});

test("recovery tick cannot be configured faster than one minute", () => {
  assert.match(worker, /Math\.max\(Number\(process\.env\.MOBILE_ACCESS_RECOVERY_TICK_MS \?\? 60_000\), 60_000\)/);
});

test("worker remains dormant: no package or Railway process wiring", () => {
  assert.doesNotMatch(pkg, /mobile-access-recovery\.worker/);
  assert.doesNotMatch(railway, /mobile-access-recovery\.worker/);
});
