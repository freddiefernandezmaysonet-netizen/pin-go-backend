import assert from "node:assert/strict";
import test from "node:test";
import { createAirbnbActivationHttpTransport, AirbnbActivationError } from "./airbnb-host-activation.http-transport.js";
const id = "44444444-4444-4444-8444-444444444444";
const base = {
  env: { NODE_ENV: "production", OTA_CONNECTION_API_KEY: "canonical-test-key", OTA_CONNECTION_PROVIDER_API_ORIGIN: "https://app.channex.io" },
  apiOrigin: "https://staging.channex.io", apiKey: "ignored-legacy-test-key", timeoutMs: 1000,
};

test("production activation uses canonical credentials/origin and exact documented POST/meta response", async () => {
  const calls: any[] = [];
  const t = createAirbnbActivationHttpTransport({ ...base, fetchImpl: async (url, options) => {
    calls.push({ url, options }); return Response.json({ meta: { message: "success" } });
  } });
  await t.activate(id);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `https://app.channex.io/api/v1/channels/${id}/activate`);
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.redirect, "error");
  assert.equal(calls[0].options.headers["user-api-key"], "canonical-test-key");
  assert.equal(calls[0].options.body, undefined);
});

test("production invalid or legacy-only configuration prevents requests", () => {
  let requests = 0;
  for (const env of [
    { NODE_ENV: "production", CHANNEX_API_KEY: "legacy", CHANNEX_API_BASE_URL: "https://staging.channex.io" },
    { ...base.env, OTA_CONNECTION_PROVIDER_API_ORIGIN: "https://staging.channex.io" },
    { ...base.env, OTA_CONNECTION_PROVIDER_API_ORIGIN: "https://app.channex.io/other" },
    { ...base.env, OTA_CONNECTION_API_KEY: "" },
  ]) assert.throws(() => createAirbnbActivationHttpTransport({ ...base, env, fetchImpl: async () => { requests++; return Response.json({}); } }));
  assert.equal(requests, 0);
});

test("channel path injection is rejected before sending credentials", async () => {
  let requests = 0;
  const t = createAirbnbActivationHttpTransport({ ...base, fetchImpl: async () => { requests++; return Response.json({}); } });
  await assert.rejects(() => t.activate(`${id}/deactivate`));
  assert.equal(requests, 0);
});

for (const [label, response, code, uncertain] of [
  ["unauthorized", () => Response.json({ private: "do not expose" }, { status: 401 }), "OTA_AIRBNB_ACTIVATION_REQUEST_REJECTED", false],
  ["forbidden", () => Response.json({}, { status: 403 }), "OTA_AIRBNB_ACTIVATION_REQUEST_REJECTED", false],
  ["invalid", () => Response.json({}, { status: 422 }), "OTA_AIRBNB_ACTIVATION_REQUEST_REJECTED", false],
  ["rate limited", () => Response.json({}, { status: 429 }), "OTA_AIRBNB_ACTIVATION_RATE_LIMITED", false],
  ["server unavailable", () => Response.json({}, { status: 503 }), "OTA_AIRBNB_ACTIVATION_RECONCILIATION_REQUIRED", true],
  ["redirect", () => new Response(null, { status: 302 }), "OTA_AIRBNB_ACTIVATION_RECONCILIATION_REQUIRED", true],
  ["resource-shaped success", () => Response.json({ data: { id } }), "OTA_AIRBNB_ACTIVATION_RECONCILIATION_REQUIRED", true],
  ["invalid JSON", () => new Response("private provider error"), "OTA_AIRBNB_ACTIVATION_RECONCILIATION_REQUIRED", true],
  ["oversized response", () => new Response("x".repeat(65537)), "OTA_AIRBNB_ACTIVATION_RECONCILIATION_REQUIRED", true],
  ["connection reset", () => { throw new Error("private key must not appear"); }, "OTA_AIRBNB_ACTIVATION_RECONCILIATION_REQUIRED", true],
] as const) test(`${label}: sanitized error, no automatic retry`, async () => {
  let requests = 0;
  const t = createAirbnbActivationHttpTransport({ ...base, fetchImpl: async () => { requests++; return response(); } });
  await assert.rejects(() => t.activate(id), e => e instanceof AirbnbActivationError && e.code === code && e.uncertain === uncertain && !e.message.includes("private"));
  assert.equal(requests, 1);
});

test("timeout aborts request and leaves outcome uncertain without retry", async () => {
  let requests = 0;
  const t = createAirbnbActivationHttpTransport({ ...base, fetchImpl: async (_url, options) => {
    requests++;
    return new Promise((_resolve, reject) => options!.signal!.addEventListener("abort", () => reject(new Error("aborted"))));
  } });
  await assert.rejects(() => t.activate(id), e => e instanceof AirbnbActivationError && e.uncertain);
  assert.equal(requests, 1);
});
