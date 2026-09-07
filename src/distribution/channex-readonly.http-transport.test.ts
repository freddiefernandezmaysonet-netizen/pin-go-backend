import assert from "node:assert/strict";
import test from "node:test";

import {
  ChannexReadonlyTransportError,
  createChannexReadonlyHttpTransport,
} from "./channex-readonly.http-transport.js";

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("allows only exact Channex staging/production origins", () => {
  assert.throws(
    () => createChannexReadonlyHttpTransport({ apiOrigin: "https://evil.example", apiKey: "k", timeoutMs: 1000 }),
    (e: unknown) => e instanceof ChannexReadonlyTransportError && e.code === "OTA_READONLY_PROVIDER_API_ORIGIN_INVALID"
  );
});

test("GET property uses user-api-key and no request body", async () => {
  const calls: any[] = [];
  const transport = createChannexReadonlyHttpTransport({
    apiOrigin: "https://staging.channex.io",
    apiKey: "secret",
    timeoutMs: 1000,
    fetchImpl: async (input, init) => {
      calls.push({ url: String(input), init });
      return response({ data: { id: "prop-1" } });
    },
  });
  await transport.getProperty("prop-1");
  assert.equal(calls[0].url, "https://staging.channex.io/api/v1/properties/prop-1");
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[0].init.headers["user-api-key"], "secret");
  assert.equal("body" in calls[0].init, false);
});

test("room type lookup pins property filter", async () => {
  let url = "";
  const transport = createChannexReadonlyHttpTransport({
    apiOrigin: "https://staging.channex.io",
    apiKey: "secret",
    timeoutMs: 1000,
    fetchImpl: async (input) => { url = String(input); return response({ data: [] }); },
  });
  await transport.listRoomTypes("prop-1");
  assert.match(url, /\/api\/v1\/room_types\?filter%5Bproperty_id%5D=prop-1$/);
});

test("rate plan lookup pins property filter", async () => {
  let url = "";
  const transport = createChannexReadonlyHttpTransport({
    apiOrigin: "https://staging.channex.io",
    apiKey: "secret",
    timeoutMs: 1000,
    fetchImpl: async (input) => { url = String(input); return response({ data: [] }); },
  });
  await transport.listRatePlans("prop-1");
  assert.match(url, /\/api\/v1\/rate_plans\?filter%5Bproperty_id%5D=prop-1$/);
});

test("rejects unsafe resource ids", () => {
  const transport = createChannexReadonlyHttpTransport({
    apiOrigin: "https://staging.channex.io",
    apiKey: "secret",
    timeoutMs: 1000,
    fetchImpl: async () => response({ data: {} }),
  });
  assert.throws(
    () => transport.getProperty("../secrets"),
    (e: unknown) => e instanceof ChannexReadonlyTransportError && e.code === "OTA_READONLY_PROPERTY_ID_INVALID"
  );
});
