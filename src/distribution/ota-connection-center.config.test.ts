import assert from "node:assert/strict";
import test from "node:test";

import { resolveOtaConnectionCenterConfig } from "./ota-connection-center.config.js";

const complete = {
  OTA_CONNECTION_CENTER_ENABLED: "true",
  OTA_CONNECTION_PROVIDER_API_ORIGIN: "https://staging.channex.io",
  OTA_CONNECTION_API_KEY: "staging-test-key",
  OTA_CONNECTION_IFRAME_BASE_URL: "https://staging.channex.io/channels",
  OTA_CONNECTION_DEFAULT_CURRENCY: "usd",
  OTA_CONNECTION_AIRBNB_FILTER: "airbnb-explicit-filter",
  OTA_CONNECTION_BOOKING_FILTER: "booking-explicit-filter",
};

test("configuration is default-off without inspecting optional provider values", () => {
  assert.deepEqual(resolveOtaConnectionCenterConfig({
    OTA_CONNECTION_API_KEY: "unused-secret",
  }), { enabled: false, reason: "DEFAULT_OFF" });
  assert.deepEqual(resolveOtaConnectionCenterConfig({
    OTA_CONNECTION_CENTER_ENABLED: "yes",
  }), { enabled: false, reason: "INVALID_CONFIGURATION" });
});

test("enabled runtime requires every provider value and matching exact origins", () => {
  for (const env of [
    { ...complete, OTA_CONNECTION_API_KEY: "" },
    { ...complete, OTA_CONNECTION_PROVIDER_API_ORIGIN: "https://evil.example" },
    { ...complete, OTA_CONNECTION_IFRAME_BASE_URL: "https://app.channex.io/channels" },
    { ...complete, OTA_CONNECTION_BOOKING_FILTER: "" },
    { ...complete, OTA_CONNECTION_DEFAULT_CURRENCY: "US dollars" },
    { ...complete, OTA_CONNECTION_HTTP_TIMEOUT_MS: "999" },
  ]) {
    assert.deepEqual(resolveOtaConnectionCenterConfig(env), {
      enabled: false,
      reason: "CONFIGURATION_INCOMPLETE",
    });
  }
});

test("complete staging configuration normalizes only non-secret values", () => {
  const config = resolveOtaConnectionCenterConfig(complete);
  assert.equal(config.enabled, true);
  if (!config.enabled) return;
  assert.equal(config.provider.apiOrigin, "https://staging.channex.io");
  assert.equal(config.provider.iframeBaseUrl, "https://staging.channex.io/channels");
  assert.equal(config.provider.defaultCurrency, "USD");
  assert.equal(config.provider.timeoutMs, 10_000);
  assert.deepEqual(config.provider.channelFilterByProvider, {
    AIRBNB: "airbnb-explicit-filter",
    BOOKING_COM: "booking-explicit-filter",
  });
});
