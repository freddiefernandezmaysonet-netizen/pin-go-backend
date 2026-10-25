import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";

const worker = await fs.readFile(new URL("../workers/mobile-access-recovery.worker.ts", import.meta.url), "utf8");
const pkg = await fs.readFile(new URL("../../package.json", import.meta.url), "utf8");
const railway = await fs.readFile(new URL("../../railway.json", import.meta.url), "utf8").catch(() => "");
const server = await fs.readFile(new URL("../server.ts", import.meta.url), "utf8");

test("recovery worker queries DB-driven due work and never polls TTLock directly", () => {
  assert.match(worker, /findMobileAccessRevocationsDue/);
  assert.match(worker, /runDueMobileAccessRecovery/);
  assert.match(worker, /revokeMobileAccessCredentialById/);
  assert.doesNotMatch(worker, /axios|TTLockMobileAccessProvider|api\.sciener|\/v3\//i);
});

test("recovery tick cannot be configured faster than one minute", () => {
  assert.match(worker, /Math\.max\(Number\(process\.env\.MOBILE_ACCESS_RECOVERY_TICK_MS \?\? 60_000\), 60_000\)/);
});

test("worker process is runnable but default-off until explicitly enabled", () => {
  assert.match(pkg, /"worker:mobile-access-recovery":\s*"tsx src\/workers\/mobile-access-recovery\.worker\.ts"/);
  assert.match(worker, /MOBILE_ACCESS_RECOVERY_WORKER_ENABLED === "true"/);
  assert.match(worker, /startMobileAccessRecoveryWorker\(\)/);
  assert.doesNotMatch(railway, /mobile-access-recovery\.worker|worker:mobile-access-recovery/);
});

test("API server never imports or starts Mobile Access Recovery worker", () => {
  assert.doesNotMatch(server, /mobile-access-recovery\.worker|startMobileAccessRecoveryWorker|runMobileAccessRecoveryTick/);
});

test("observer defers credentials with scheduled recovery to the retry runner", () => {
  assert.match(worker, /if \(credential\.recoveryNextAttemptAt\) continue/);
  assert.match(worker, /RECOVERY_SCHEDULED/);
});

test("combined tick reports observation and retry work separately", () => {
  assert.match(worker, /observed: observedResults\.length/);
  assert.match(worker, /recovery,/);
  assert.match(worker, /recoveryProcessed: result\.recovery\.processed/);
});
