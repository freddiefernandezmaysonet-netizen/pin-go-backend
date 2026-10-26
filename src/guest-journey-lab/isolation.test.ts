import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { assertLabEnvironment, LAB_ENVIRONMENT_ID, LAB_PROJECT_ID } from "./isolation";

const valid = (): NodeJS.ProcessEnv => ({
  RAILWAY_PROJECT_ID: LAB_PROJECT_ID,
  RAILWAY_ENVIRONMENT_ID: LAB_ENVIRONMENT_ID,
  RAILWAY_ENVIRONMENT_NAME: "guest-journey-test",
  GUEST_JOURNEY_LAB_MODE: "simulation",
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://guest_journey_lab:synthetic-test-password@postgres.railway.internal:5432/guest_journey_lab",
});

test("accepts only the dedicated lab identity and database", () => {
  assert.equal(assertLabEnvironment(valid()).pathname, "/guest_journey_lab");
  for (const key of ["RAILWAY_PROJECT_ID", "RAILWAY_ENVIRONMENT_ID", "RAILWAY_ENVIRONMENT_NAME", "NODE_ENV", "GUEST_JOURNEY_LAB_MODE"]) {
    assert.throws(() => assertLabEnvironment({ ...valid(), [key]: "production" }), /ISOLATION_SCOPE_REJECTED/);
  }
});

test("rejects public, production, alternate, malformed and parameter-overridden databases", () => {
  for (const url of [
    "postgresql://guest_journey_lab:p@prod.example.com:5432/guest_journey_lab",
    "postgresql://guest_journey_lab:p@postgres.railway.internal:5432/production",
    "postgresql://postgres:p@postgres.railway.internal:5432/guest_journey_lab",
    "postgresql://guest_journey_lab:p@postgres.railway.internal:5432/guest_journey_lab?host=other",
    "postgresql://guest_journey_lab:p@127.0.0.1:5432/guest_journey_lab",
    "not-a-url",
  ]) assert.throws(() => assertLabEnvironment({ ...valid(), DATABASE_URL: url }), /DATABASE_/);
});

test("rejects provider credentials and real worker activation flags without printing values", () => {
  for (const key of ["TWILIO_API_SECRET", "RESEND_API_KEY", "STRIPE_SECRET_KEY", "CHANNEX_API_KEY", "TTLOCK_CLIENT_SECRET", "OPENAI_API_KEY", "ACCESS_CODE_ENC_KEY_BASE64"]) {
    assert.throws(() => assertLabEnvironment({ ...valid(), [key]: "sensitive-placeholder" }), error =>
      error instanceof Error && error.message.includes(key) && !error.message.includes("sensitive-placeholder"));
  }
  for (const key of ["GUEST_JOURNEY_COMMUNICATIONS_EXECUTE", "GUEST_JOURNEY_ACCESS_OWNER_EXECUTE", "GUEST_JOURNEY_FINANCIAL_OWNER_EXECUTE", "GUEST_JOURNEY_COMPLIANCE_OWNER_EXECUTE", "GUEST_JOURNEY_SHADOW_ENABLED"]) {
    assert.throws(() => assertLabEnvironment({ ...valid(), [key]: "true" }), /CYCLE_FLAG_REJECTED/);
  }
});

test("network fence rejects fetch, HTTP, HTTPS, TCP and TLS before any request", () => {
  const isolationUrl = new URL("./isolation.ts", import.meta.url).href;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import assert from 'node:assert/strict';
    import http from 'node:http'; import https from 'node:https';
    import net from 'node:net'; import tls from 'node:tls';
    const { installLabNetworkFence } = await import(${JSON.stringify(isolationUrl)});
    installLabNetworkFence();
    await assert.rejects(fetch('https://example.invalid'), /EXTERNAL_NETWORK_BLOCKED/);
    for (const attempt of [
      () => http.request('http://example.invalid'), () => https.get('https://example.invalid'),
      () => net.connect(443, 'example.invalid'), () => new net.Socket().connect(443, 'example.invalid'),
      () => tls.connect(443, 'example.invalid'),
    ]) assert.throws(attempt, /EXTERNAL_NETWORK_BLOCKED/);
    console.log('network-fence-pass');
  `], { encoding: "utf8", timeout: 10_000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /network-fence-pass/);
});
