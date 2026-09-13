import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(path: string): string {
  return readFileSync(path, "utf8");
}

test("every production Channex HTTP consumer resolves the canonical runtime transport", () => {
  for (const path of [
    "src/services/channex-provisioning.service.ts",
    "src/services/channex-availability-sync.service.ts",
    "src/pms/adapters/channex.adapter.ts",
    "src/pms/outbound/channex-ari-http.client.ts",
    "src/routes/org.pms.routes.ts",
  ]) {
    assert.match(
      source(path),
      /resolveChannexRuntimeTransport/,
      `${path} must pass through the production Channex transport boundary`
    );
  }
});

test("legacy provisioning and availability cannot read CHANNEX variables directly", () => {
  for (const path of [
    "src/services/channex-provisioning.service.ts",
    "src/services/channex-availability-sync.service.ts",
  ]) {
    const contents = source(path);
    assert.doesNotMatch(contents, /process\.env\.CHANNEX_API_KEY/);
    assert.doesNotMatch(contents, /process\.env\.CHANNEX_API_BASE_URL/);
    assert.doesNotMatch(contents, /staging\.channex\.io/);
  }
});

test("runtime PMS connection test has no hard-coded staging endpoint", () => {
  const contents = source("src/routes/org.pms.routes.ts");
  assert.doesNotMatch(contents, /staging\.channex\.io/);
  assert.match(contents, /transport\.apiOrigin/);
  assert.match(contents, /transport\.apiKey/);
});

test("worker entrypoints reach Channex only through guarded components", () => {
  const recovery = source("src/workers/pms-webhook-recovery.worker.ts");
  const globalFeed = source("src/workers/channex-global-feed.worker.ts");
  const ari = source("src/workers/channex-ari-dispatch.process.ts");

  assert.doesNotMatch(recovery, /CHANNEX_API_(?:KEY|BASE_URL)/);
  assert.doesNotMatch(globalFeed, /CHANNEX_API_(?:KEY|BASE_URL)/);
  assert.match(ari, /OTA_CONNECTION_API_KEY/);
  assert.match(ari, /OTA_CONNECTION_PROVIDER_API_ORIGIN/);
  assert.match(ari, /CHANNEX_ARI_PRODUCTION_ORIGIN_REQUIRED/);
});
