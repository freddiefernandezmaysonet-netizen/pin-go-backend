import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";

const revoke = await fs.readFile(new URL("./mobile-access-revocation.service.ts", import.meta.url), "utf8");
const recovery = await fs.readFile(new URL("./mobile-access-recovery.service.ts", import.meta.url), "utf8");
const policy = await fs.readFile(new URL("./mobile-access-recovery.policy.ts", import.meta.url), "utf8");
const worker = await fs.readFile(new URL("../workers/reservation.worker.ts", import.meta.url), "utf8");

test("failed revoke schedules bounded recovery metadata", () => {
  assert.match(revoke, /nextMobileAccessRecovery/);
  assert.match(revoke, /recoveryAttemptCount/);
  assert.match(revoke, /recoveryNextAttemptAt/);
  assert.match(revoke, /recoveryExhaustedAt/);
});

test("recovery policy is bounded to eight attempts", () => {
  assert.match(policy, /MOBILE_ACCESS_RECOVERY_MAX_ATTEMPTS = 8/);
  assert.match(policy, /60_000/);
  assert.match(policy, /24 \* 60 \* 60_000/);
});

test("recovery runner processes only due non-exhausted credentials with bounded batch", () => {
  assert.match(recovery, /recoveryNextAttemptAt: \{ lte: now \}/);
  assert.match(recovery, /recoveryExhaustedAt: null/);
  assert.match(recovery, /Math\.min\(Math\.max\(input\.limit \?\? 25, 1\), 100\)/);
  assert.match(recovery, /RETRY_SCHEDULED/);
  assert.match(recovery, /EXHAUSTED/);
});

test("no production worker invokes mobile recovery yet", () => {
  assert.doesNotMatch(worker, /runDueMobileAccessRecovery/);
});
