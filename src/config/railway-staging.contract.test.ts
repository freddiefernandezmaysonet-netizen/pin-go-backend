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

function assertIndependentWorkerConfig(args: {
  config: Awaited<ReturnType<typeof readJson>>;
  startCommand: string;
}) {
  assert.equal(args.config.build?.builder, "RAILPACK");
  assert.equal(args.config.deploy?.startCommand, args.startCommand);
  assert.equal(args.config.deploy?.healthcheckPath, undefined);
  assert.equal(args.config.deploy?.healthcheckTimeout, undefined);
  assert.equal(args.config.deploy?.restartPolicyType, "ON_FAILURE");
  assert.equal(args.config.deploy?.restartPolicyMaxRetries, 10);
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

  assertIndependentWorkerConfig({
    config,
    startCommand: "npm run worker:pms-webhook-recovery",
  });
});

test("Railway global Channex Feed worker config remains an independent non-HTTP service", async () => {
  const config = await readJson("../../railway.channex-global-feed.json");

  assertIndependentWorkerConfig({
    config,
    startCommand: "npm run worker:channex-global-feed",
  });
});

test("Railway API and workers use distinct start commands", async () => {
  const apiConfig = await readJson("../../railway.api.json");
  const recoveryWorkerConfig = await readJson(
    "../../railway.pms-webhook-recovery.json"
  );
  const globalFeedWorkerConfig = await readJson(
    "../../railway.channex-global-feed.json"
  );
  const commands = [
    apiConfig.deploy?.startCommand,
    recoveryWorkerConfig.deploy?.startCommand,
    globalFeedWorkerConfig.deploy?.startCommand,
  ];

  assert.equal(new Set(commands).size, commands.length);
});
