import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

async function readPackageScripts() {
  const raw = await readFile(new URL("../../package.json", import.meta.url), "utf8");
  const packageJson = JSON.parse(raw) as {
    scripts?: Record<string, string>;
  };

  return packageJson.scripts ?? {};
}

test("API startup command is explicit and targets only server.ts", async () => {
  const scripts = await readPackageScripts();

  assert.equal(scripts.start, "tsx src/server.ts");
  assert.doesNotMatch(scripts.start ?? "", /worker/i);
});

test("Pin&Go Connect recovery worker has an independent command", async () => {
  const scripts = await readPackageScripts();

  assert.equal(
    scripts["worker:pms-webhook-recovery"],
    "tsx src/workers/pms-webhook-recovery.worker.ts"
  );
  assert.notEqual(
    scripts.start,
    scripts["worker:pms-webhook-recovery"]
  );
});

test("staging webhook configuration remains an explicit one-off command", async () => {
  const scripts = await readPackageScripts();

  assert.equal(
    scripts["channex:staging:configure-booking-webhook"],
    "tsx src/scripts/configure-channex-staging-booking-webhook.ts"
  );
  assert.notEqual(
    scripts.start,
    scripts["channex:staging:configure-booking-webhook"]
  );
});
