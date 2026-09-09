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

test("structured 4xx exposes only a bounded sanitized diagnostic code", async () => {
  const transport = createChannexWhiteLabelHttpTransport({
    apiOrigin: "https://staging.channex.io",
    timeoutMs: 5_000,
    fetchImpl: async () => new Response(JSON.stringify({
      errors: [{
        code: "invalid_redirect_uri",
        detail: "redirect_uri https://secret.example/callback?token=abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 is invalid",
      }],
    }), { status: 422, headers: { "Content-Type": "application/json" } }),
  });

  await assert.rejects(
    transport.send(request),
    (error: unknown) => {
      assert.ok(error instanceof WhiteLabelHttpTransportError);
      assert.equal(error.retryDisposition, "SAFE_RETRY");
      assert.equal(error.providerStatus, 422);
      assert.equal(error.providerCode, "invalid_redirect_uri");
      assert.ok(error.providerMessage?.includes("[URL_REDACTED]"));
      assert.ok(error.code.startsWith("OTA_PROVIDER_REQUEST_REJECTED__P422__INVALID_REDIRECT_URI__"));
      assert.ok(error.code.includes("URL_REDACTED"));
      assert.ok(!error.code.includes("secret.example"));
      assert.ok(!error.code.includes("abcdefghijklmnopqrstuvwxyz"));
      assert.ok(!error.code.includes("secret-test-key"));
      assert.equal(error.message, error.code);
      assert.ok(error.code.length <= 320);
      return true;
    }
  );
});

test("documented Channex 422 details are observable per argument without secret values", async () => {
  const transport = createChannexWhiteLabelHttpTransport({
    apiOrigin: "https://app.channex.io",
    timeoutMs: 5_000,
    fetchImpl: async () => new Response(JSON.stringify({
      details: {
        group_id: ["is invalid"],
        properties: { 0: ["does not belong to group"] },
        redirect_uri: ["https://private.example/callback?token=abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 is not allowed"],
        token: ["secret-value-must-never-appear"],
      },
    }), { status: 422, headers: { "Content-Type": "application/json" } }),
  });

  await assert.rejects(
    transport.send(request),
    (error: unknown) => {
      assert.ok(error instanceof WhiteLabelHttpTransportError);
      assert.equal(error.providerStatus, 422);
      assert.equal(error.providerCode, "validation_details");
      assert.ok(error.providerMessage?.includes("group_id[0]=is invalid"));
      assert.ok(error.providerMessage?.includes("properties.0[0]=does not belong to group"));
      assert.ok(error.providerMessage?.includes("redirect_uri[0]=[URL_REDACTED]"));
      assert.ok(error.providerMessage?.includes("token=[REDACTED]"));
      assert.ok(error.code.startsWith("OTA_PROVIDER_REQUEST_REJECTED__P422__VALIDATION_DETAILS__"));
      assert.ok(error.code.includes("GROUP_ID_0_IS_INVALID"));
      assert.ok(error.code.includes("PROPERTIES_0_0_DOES_NOT_BELONG_TO_GROUP"));
      assert.ok(!error.code.includes("private.example"));
      assert.ok(!error.code.includes("abcdefghijklmnopqrstuvwxyz"));
      assert.ok(!error.code.includes("secret-value-must-never-appear"));
      assert.ok(!error.code.includes("secret-test-key"));
      assert.ok(error.code.length <= 320);
      return true;
    }
  );
});

test("unstructured or oversized 4xx exposes status only and never raw bodies", async () => {
  for (const body of ["rejected-secret", "x".repeat(20_000)]) {
    const transport = createChannexWhiteLabelHttpTransport({
      apiOrigin: "https://staging.channex.io",
      timeoutMs: 5_000,
      fetchImpl: async () => new Response(body, { status: 422 }),
    });
    await assert.rejects(
      transport.send(request),
      (error: unknown) => {
        assert.ok(error instanceof WhiteLabelHttpTransportError);
        assert.equal(error.providerStatus, 422);
        assert.equal(error.providerCode, null);
        assert.equal(error.providerMessage, null);
        assert.equal(error.code, "OTA_PROVIDER_REQUEST_REJECTED__P422");
        assert.ok(!error.code.includes("rejected-secret"));
        return true;
      }
    );
  }
});

test("network and 5xx outcomes still require reconciliation", async () => {
  for (const scenario of [
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
