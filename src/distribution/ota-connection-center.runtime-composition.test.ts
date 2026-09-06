import assert from "node:assert/strict";
import test from "node:test";

import { buildRuntimeOtaConnectionCenterComposition } from "./ota-connection-center.runtime-composition.js";

const complete = {
  OTA_CONNECTION_CENTER_ENABLED: "true",
  OTA_CONNECTION_PROVIDER_API_ORIGIN: "https://staging.channex.io",
  OTA_CONNECTION_API_KEY: "staging-test-key",
  OTA_CONNECTION_IFRAME_BASE_URL: "https://staging.channex.io/channels",
  OTA_CONNECTION_DEFAULT_CURRENCY: "USD",
  OTA_CONNECTION_AIRBNB_FILTER: "airbnb-explicit-filter",
  OTA_CONNECTION_BOOKING_FILTER: "booking-explicit-filter",
};

test("runtime composition remains inert by default and when incomplete", () => {
  let fetchCalls = 0;
  const fetchImpl = async () => {
    fetchCalls += 1;
    return new Response("{}");
  };
  const base = {
    prisma: {} as any,
    trustedMutationOrigins: ["https://app.pin-ngo.com"],
    fetchImpl,
  };
  assert.deepEqual(
    buildRuntimeOtaConnectionCenterComposition({ ...base, env: {} }).runtime,
    { enabled: false, reason: "DEFAULT_OFF" }
  );
  assert.deepEqual(
    buildRuntimeOtaConnectionCenterComposition({
      ...base,
      env: { OTA_CONNECTION_CENTER_ENABLED: "true" },
    }).runtime,
    { enabled: false, reason: "CONFIGURATION_INCOMPLETE" }
  );
  assert.equal(fetchCalls, 0);
});

test("complete configuration composes actions but performs no eager request", () => {
  let fetchCalls = 0;
  const actions = buildRuntimeOtaConnectionCenterComposition({
    prisma: {} as any,
    env: complete,
    trustedMutationOrigins: ["https://app.pin-ngo.com"],
    fetchImpl: async () => {
      fetchCalls += 1;
      return new Response("{}");
    },
  });
  assert.deepEqual(actions.runtime, { enabled: true, reason: "ENABLED" });
  assert.equal(typeof actions.prepare, "function");
  assert.equal(typeof actions.issueSession, "function");
  assert.equal(typeof actions.transitionSession, "function");
  assert.equal(fetchCalls, 0);
});
