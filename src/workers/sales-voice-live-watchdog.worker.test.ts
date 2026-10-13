import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isSalesVoiceWatchdogStagingWorkerEnabled,
  salesVoiceWorkerSettings,
  runIsolatedSalesVoiceWatchdogWorker,
} from "./sales-voice-live-watchdog.worker.js";

const enabled = {
  RAILWAY_ENVIRONMENT_NAME: "staging",
  SALES_VOICE_WATCHDOG_ENABLED: "true",
  SALES_VOICE_WATCHDOG_RELEASE_CERTIFIED: "true",
  NODE_ENV: "test",
};

test("worker is disabled without explicit full staging gates", () => {
  assert.equal(isSalesVoiceWatchdogStagingWorkerEnabled({}),false);
  assert.equal(isSalesVoiceWatchdogStagingWorkerEnabled({...enabled,RAILWAY_ENVIRONMENT_NAME:"production"}),false);
  assert.equal(isSalesVoiceWatchdogStagingWorkerEnabled({...enabled,NODE_ENV:"production"}),false);
  assert.equal(isSalesVoiceWatchdogStagingWorkerEnabled({...enabled,SALES_VOICE_WATCHDOG_ENABLED:"false"}),false);
  assert.equal(isSalesVoiceWatchdogStagingWorkerEnabled({...enabled,SALES_VOICE_WATCHDOG_RELEASE_CERTIFIED:"false"}),false);
  assert.equal(isSalesVoiceWatchdogStagingWorkerEnabled(enabled),true);
});

test("disabled worker never needs DB URL or API key and exits without provider requests",async () => {
  const original = console.log;
  const outputs: string[]=[];
  console.log=(...parts:unknown[])=>outputs.push(parts.join(" "));
  try {
    await runIsolatedSalesVoiceWatchdogWorker({
      RAILWAY_ENVIRONMENT_NAME:"production",
      SALES_VOICE_WATCHDOG_ENABLED:"true",
      SALES_VOICE_WATCHDOG_RELEASE_CERTIFIED:"true",
      NODE_ENV:"production",
    });
  } finally { console.log=original; }
  assert.match(outputs.join("\n"),/disabled/);
});

test("worker enforces bounded batch size, polling cadence, and call age", () => {
  assert.deepEqual(salesVoiceWorkerSettings({}),{
    maxCallSeconds:300,batchSize:10,pollMs:30000,
  });
  assert.throws(()=>salesVoiceWorkerSettings({SALES_VOICE_WATCHDOG_BATCH_SIZE:"0"}),/INVALID_WORKER_SETTINGS/);
  assert.throws(()=>salesVoiceWorkerSettings({SALES_VOICE_MAX_CALL_SECONDS:"30"}),/INVALID_WORKER_SETTINGS/);
  assert.throws(()=>salesVoiceWorkerSettings({SALES_VOICE_WATCHDOG_POLL_MS:"1000"}),/INVALID_WORKER_SETTINGS/);
  assert.throws(()=>salesVoiceWorkerSettings({SALES_VOICE_WATCHDOG_POLL_MS:"NaN"}),/INVALID_WORKER_SETTINGS/);
});

test("no API key or database means no staging worker process",async () => {
  await assert.rejects(runIsolatedSalesVoiceWatchdogWorker(enabled),/MISSING_API_KEY/);
  await assert.rejects(runIsolatedSalesVoiceWatchdogWorker({
    ...enabled,OPENAI_API_KEY:"sk-test-isolated",
  }),/MISSING_DATABASE_URL/);
});
