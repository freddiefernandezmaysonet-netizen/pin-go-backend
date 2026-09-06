import assert from "node:assert/strict";
import test from "node:test";

import {
  createChannexWhiteLabelHttpTransport,
  WhiteLabelHttpTransportError,
} from "./channex-white-label.http-transport.js";

const request = {
  method: "POST" as const,
  path: "/api/v1/groups",
  headers: {
    "user-api-key": "secret-test-key",
    "Content-Type": "application/json",
  },
  body: { group: { title: "Test" } },
};

test("transport sends only an allowlisted HTTPS request with bounded options", async () => {
  let received: { input: URL | RequestInfo; init?: RequestInit } | null = null;
  const transport = createChannexWhiteLabelHttpTransport({
    apiOrigin: "https://staging.channex.io",
    timeoutMs: 5_000,
    fetchImpl: async (input, init) => {
      received = { input, init };
      return new Response(JSON.stringify({ data: { id: "group-ext" } }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    },
  });

  assert.deepEqual(await transport.send(request), { data: { id: "group-ext" } });
  assert.equal(String(received?.input), "https://staging.channex.io/api/v1/groups");
  assert.equal(received?.init?.method, "POST");
  assert.equal(received?.init?.redirect, "error");
  assert.equal(received?.init?.body, JSON.stringify(request.body));
  assert.deepEqual(received?.init?.headers, {
    Accept: "application/json",
    "user-api-key": "secret-test-key",
    "Content-Type": "application/json",
  });
});

test("transport rejects non-allowlisted origins and paths before fetch", async () => {
  let calls = 0;
  assert.throws(
    () => createChannexWhiteLabelHttpTransport({
      apiOrigin: "https://evil.example",
      timeoutMs: 5_000,
      fetchImpl: async () => { calls += 1; return new Response("{}"); },
    }),
    (error: unknown) =>
      error instanceof WhiteLabelHttpTransportError &&
      error.code === "OTA_PROVIDER_API_ORIGIN_INVALID"
  );

  const transport = createChannexWhiteLabelHttpTransport({
    apiOrigin: "https://staging.channex.io",
    timeoutMs: 5_000,
    fetchImpl: async () => { calls += 1; return new Response("{}"); },
  });
  await assert.rejects(
    transport.send({ ...request, path: "/api/v1/bookings" }),
    (error: unknown) =>
      error instanceof WhiteLabelHttpTransportError &&
      error.code === "OTA_PROVIDER_REQUEST_NOT_ALLOWED"
  );
  await assert.rejects(
    transport.send({ ...request, headers: { "Content-Type": "application/json" } }),
    (error: unknown) =>
      error instanceof WhiteLabelHttpTransportError &&
      error.code === "OTA_PROVIDER_CREDENTIALS_UNAVAILABLE"
  );
  assert.equal(calls, 0);
});

test("4xx is retry-safe while network and 5xx outcomes require reconciliation", async () => {
  for (const scenario of [
    {
      response: async () => new Response("rejected-secret", { status: 422 }),
      code: "OTA_PROVIDER_REQUEST_REJECTED",
      retryDisposition: "SAFE_RETRY",
    },
    {
      response: async () => new Response("provider-secret", { status: 503 }),
      code: "OTA_PROVIDER_RECONCILIATION_REQUIRED",
      retryDisposition: "RECONCILIATION_REQUIRED",
    },
    {
      response: async () => { throw new Error("network leaked secret"); },
      code: "OTA_PROVIDER_RECONCILIATION_REQUIRED",
      retryDisposition: "RECONCILIATION_REQUIRED",
    },
  ] as const) {
    const transport = createChannexWhiteLabelHttpTransport({
      apiOrigin: "https://staging.channex.io",
      timeoutMs: 5_000,
      fetchImpl: scenario.response,
    });
    await assert.rejects(
      transport.send(request),
      (error: unknown) => {
        assert.ok(error instanceof WhiteLabelHttpTransportError);
        assert.equal(error.code, scenario.code);
        assert.equal(error.retryDisposition, scenario.retryDisposition);
        assert.equal(error.message, scenario.code);
        return true;
      }
    );
  }
});

test("invalid or oversized success bodies require reconciliation", async () => {
  for (const body of ["not-json", "x".repeat(1_000_001)]) {
    const transport = createChannexWhiteLabelHttpTransport({
      apiOrigin: "https://app.channex.io",
      timeoutMs: 5_000,
      fetchImpl: async () => new Response(body, { status: 200 }),
    });
    await assert.rejects(
      transport.send(request),
      (error: unknown) =>
        error instanceof WhiteLabelHttpTransportError &&
        error.code === "OTA_PROVIDER_RECONCILIATION_REQUIRED"
    );
  }
});
