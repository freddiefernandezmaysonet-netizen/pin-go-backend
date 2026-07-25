import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

async function readJson(path: string) {
  const raw = await readFile(new URL(path, import.meta.url), "utf8");
  return JSON.parse(raw) as {
    build?: { builder?: string };
    deploy?: {
      startCommand?: string;
      healthcheckPath?: string;
      healthcheckTimeout?: number;
      restartPolicyType?: string;
      restartPolicyMaxRetries?: number;
    };
  };
}

test("Railway API config starts only the API and uses DB readiness", async () => {
  const config = await readJson("../../railway.api.json");

  assert.equal(config.build?.builder, "RAILPACK");
  assert.equal(config.deploy?.startCommand, "npm start");
  assert.equal(config.deploy?.healthcheckPath, "/ready");
  assert.equal(config.deploy?.healthcheckTimeout, 300);
  assert.equal(config.deploy?.restartPolicyType, "ON_FAILURE");
  assert.equal(config.deploy?.restartPolicyMaxRetries, 10);
});

test("Railway recovery worker config remains an independent non-HTTP service", async () => {
  const config = await readJson(
    "../../railway.pms-webhook-recovery.json"
  );

  assert.equal(config.build?.builder, "RAILPACK");
  assert.equal(
    config.deploy?.startCommand,
    "npm run worker:pms-webhook-recovery"
  );
  assert.equal(config.deploy?.healthcheckPath, undefined);
  assert.equal(config.deploy?.healthcheckTimeout, undefined);
  assert.equal(config.deploy?.restartPolicyType, "ON_FAILURE");
  assert.equal(config.deploy?.restartPolicyMaxRetries, 10);
});

test("Railway API and worker cannot share a start command", async () => {
  const apiConfig = await readJson("../../railway.api.json");
  const workerConfig = await readJson(
    "../../railway.pms-webhook-recovery.json"
  );

  assert.notEqual(
    apiConfig.deploy?.startCommand,
    workerConfig.deploy?.startCommand
  );
});
