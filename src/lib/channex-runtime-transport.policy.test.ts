import assert from "node:assert/strict";
import test from "node:test";

import {
  CHANNEX_PRODUCTION_API_ORIGIN,
  CHANNEX_STAGING_API_ORIGIN,
  resolveChannexRuntimeTransport,
} from "./channex-runtime-transport.policy.js";

test("production uses only the canonical OTA credential and app origin", () => {
  const result = resolveChannexRuntimeTransport({
    env: {
      NODE_ENV: "production",
      OTA_CONNECTION_API_KEY: "ota-production-key",
      OTA_CONNECTION_PROVIDER_API_ORIGIN: `${CHANNEX_PRODUCTION_API_ORIGIN}/`,
      CHANNEX_API_KEY: "legacy-key-must-be-ignored",
      CHANNEX_API_BASE_URL: CHANNEX_STAGING_API_ORIGIN,
    },
    nonProductionApiKey: "connection-key-must-be-ignored",
    nonProductionApiOrigin: CHANNEX_STAGING_API_ORIGIN,
  });

  assert.deepEqual(result, {
    apiKey: "ota-production-key",
    apiOrigin: CHANNEX_PRODUCTION_API_ORIGIN,
    environment: "PRODUCTION",
  });
});

test("production rejects missing OTA credentials and every non-app origin", () => {
  assert.throws(
    () =>
      resolveChannexRuntimeTransport({
        env: {
          NODE_ENV: "production",
          OTA_CONNECTION_PROVIDER_API_ORIGIN: CHANNEX_PRODUCTION_API_ORIGIN,
          CHANNEX_API_KEY: "legacy-key",
        },
      }),
    /CHANNEX_PRODUCTION_OTA_API_KEY_REQUIRED/
  );

  for (const origin of [
    CHANNEX_STAGING_API_ORIGIN,
    "https://app.channex.io.evil.example",
    "http://app.channex.io",
    "https://app.channex.io/api/v1",
  ]) {
    assert.throws(
      () =>
        resolveChannexRuntimeTransport({
          env: {
            NODE_ENV: "production",
            OTA_CONNECTION_API_KEY: "ota-production-key",
            OTA_CONNECTION_PROVIDER_API_ORIGIN: origin,
            CHANNEX_API_BASE_URL: CHANNEX_PRODUCTION_API_ORIGIN,
          },
        }),
      /CHANNEX_PRODUCTION_OTA_ORIGIN_REQUIRED/
    );
  }
});

test("non-production preserves explicit certification transport", () => {
  const result = resolveChannexRuntimeTransport({
    env: { NODE_ENV: "test" },
    nonProductionApiKey: "certification-key",
    nonProductionApiOrigin: CHANNEX_STAGING_API_ORIGIN,
  });

  assert.deepEqual(result, {
    apiKey: "certification-key",
    apiOrigin: CHANNEX_STAGING_API_ORIGIN,
    environment: "NON_PRODUCTION",
  });
});
