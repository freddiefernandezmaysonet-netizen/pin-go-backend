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

const PROPERTY_ID = "11111111-1111-4111-8111-111111111111";
const ROOM_TYPE_ID = "22222222-2222-4222-8222-222222222222";
const RATE_PLAN_ID = "33333333-3333-4333-8333-333333333333";
const CHANNEL_ID = "44444444-4444-4444-8444-444444444444";

function pageChannelId(index: number): string {
  return `55555555-5555-4555-8555-${String(index).padStart(12, "0")}`;
}

function channelMeta(
  page: number,
  total: number,
  overrides: Record<string, unknown> = {}
) {
  return {
    page,
    limit: 100,
    total,
    order_by: "inserted_at",
    order_direction: "asc",
    ...overrides,
  };
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
      return response({ data: { id: PROPERTY_ID } });
    },
  });
  await transport.getProperty(PROPERTY_ID);
  assert.equal(
    calls[0].url,
    `https://staging.channex.io/api/v1/properties/${PROPERTY_ID}`
  );
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
  await transport.listRoomTypes(PROPERTY_ID);
  assert.equal(
    url,
    `https://staging.channex.io/api/v1/room_types?filter%5Bproperty_id%5D=${PROPERTY_ID}`
  );
});

test("rate plan lookup pins property filter", async () => {
  let url = "";
  const transport = createChannexReadonlyHttpTransport({
    apiOrigin: "https://staging.channex.io",
    apiKey: "secret",
    timeoutMs: 1000,
    fetchImpl: async (input) => { url = String(input); return response({ data: [] }); },
  });
  await transport.listRatePlans(PROPERTY_ID);
  assert.equal(
    url,
    `https://staging.channex.io/api/v1/rate_plans?filter%5Bproperty_id%5D=${PROPERTY_ID}`
  );
});

test("exact room type and rate plan reads use UUID-scoped GET paths", async () => {
  const urls: string[] = [];
  const transport = createChannexReadonlyHttpTransport({
    apiOrigin: "https://staging.channex.io",
    apiKey: "secret",
    timeoutMs: 1000,
    fetchImpl: async (input, init) => {
      urls.push(String(input));
      assert.equal(init?.method, "GET");
      assert.equal("body" in (init ?? {}), false);
      return response({ data: {} });
    },
  });
  await transport.getRoomType(ROOM_TYPE_ID);
  await transport.getRatePlan(RATE_PLAN_ID);
  assert.deepEqual(urls, [
    `https://staging.channex.io/api/v1/room_types/${ROOM_TYPE_ID}`,
    `https://staging.channex.io/api/v1/rate_plans/${RATE_PLAN_ID}`,
  ]);
});

test("channel discovery is property-scoped and safely collects every reported page", async () => {
  const urls: string[] = [];
  const transport = createChannexReadonlyHttpTransport({
    apiOrigin: "https://staging.channex.io",
    apiKey: "secret",
    timeoutMs: 1000,
    fetchImpl: async (input, init) => {
      const url = new URL(String(input));
      urls.push(url.toString());
      assert.equal(init?.method, "GET");
      assert.equal("body" in (init ?? {}), false);
      const page = url.searchParams.get("pagination[page]");
      return page === "1"
        ? response({
            data: Array.from({ length: 100 }, (_, index) => ({
              type: "channel",
              id: pageChannelId(index + 1),
            })),
            meta: channelMeta(1, 101),
          })
        : response({
            data: [{ type: "channel", id: pageChannelId(101) }],
            meta: channelMeta(2, 101),
          });
    },
  });

  const payload = (await transport.listChannels(PROPERTY_ID, "Airbnb")) as any;
  assert.equal(payload.data.length, 101);
  assert.equal(payload.meta.total, 101);
  assert.equal(payload.meta.order_by, "inserted_at");
  assert.equal(payload.meta.order_direction, "asc");
  assert.equal(urls.length, 2);
  for (const [index, rawUrl] of urls.entries()) {
    const url = new URL(rawUrl);
    assert.equal(url.pathname, "/api/v1/channels");
    assert.equal(url.searchParams.get("filter[property_id]"), PROPERTY_ID);
    assert.equal(url.searchParams.get("filter[channel]"), "Airbnb");
    assert.equal(url.searchParams.get("pagination[page]"), String(index + 1));
    assert.equal(url.searchParams.get("pagination[limit]"), "100");
  }
});

test("channel discovery rejects an inconsistent provider total", async () => {
  const transport = createChannexReadonlyHttpTransport({
    apiOrigin: "https://staging.channex.io",
    apiKey: "secret",
    timeoutMs: 1000,
    fetchImpl: async (input) => {
      const page = new URL(String(input)).searchParams.get("pagination[page]");
      return page === "1"
        ? response({
            data: Array.from({ length: 100 }, (_, index) => ({ id: pageChannelId(index + 1) })),
            meta: channelMeta(1, 101),
          })
        : response({
            data: [{ id: pageChannelId(101) }],
            meta: channelMeta(2, 102),
          });
    },
  });

  await assert.rejects(
    transport.listChannels(PROPERTY_ID),
    (error: unknown) =>
      error instanceof ChannexReadonlyTransportError &&
      error.code === "OTA_READONLY_PROVIDER_RESPONSE_INVALID"
  );
});

test("channel discovery requires exact page, limit and total metadata", async () => {
  for (const meta of [
    undefined,
    { limit: 100, total: 0, order_by: "inserted_at", order_direction: "asc" },
    { page: 1, limit: 100, order_by: "inserted_at", order_direction: "asc" },
    { page: 1, total: 0, order_by: "inserted_at", order_direction: "asc" },
    channelMeta(1, 0, { limit: 99 }),
    channelMeta(1, 0, { page: "1" }),
    { page: 1, limit: 100, total: 0, order_direction: "asc" },
    { page: 1, limit: 100, total: 0, order_by: "inserted_at" },
    channelMeta(1, 0, { order_direction: "ascending" }),
  ]) {
    const transport = createChannexReadonlyHttpTransport({
      apiOrigin: "https://staging.channex.io",
      apiKey: "secret",
      timeoutMs: 1000,
      fetchImpl: async () => response({ data: [], ...(meta ? { meta } : {}) }),
    });
    await assert.rejects(
      transport.listChannels(PROPERTY_ID),
      (error: unknown) =>
        error instanceof ChannexReadonlyTransportError &&
        error.code === "OTA_READONLY_PROVIDER_RESPONSE_INVALID"
    );
  }
});

test("channel discovery rejects pagination ordering drift", async () => {
  const transport = createChannexReadonlyHttpTransport({
    apiOrigin: "https://staging.channex.io",
    apiKey: "secret",
    timeoutMs: 1000,
    fetchImpl: async (input) => {
      const page = new URL(String(input)).searchParams.get("pagination[page]");
      return page === "1"
        ? response({
            data: Array.from({ length: 100 }, (_, index) => ({
              id: pageChannelId(index + 1),
            })),
            meta: channelMeta(1, 101),
          })
        : response({
            data: [{ id: pageChannelId(101) }],
            meta: channelMeta(2, 101, { order_direction: "desc" }),
          });
    },
  });

  await assert.rejects(
    transport.listChannels(PROPERTY_ID),
    (error: unknown) =>
      error instanceof ChannexReadonlyTransportError &&
      error.code === "OTA_READONLY_PROVIDER_RESPONSE_INVALID"
  );
});

test("channel discovery rejects duplicate resources across pages", async () => {
  const transport = createChannexReadonlyHttpTransport({
    apiOrigin: "https://staging.channex.io",
    apiKey: "secret",
    timeoutMs: 1000,
    fetchImpl: async (input) => {
      const page = new URL(String(input)).searchParams.get("pagination[page]");
      return page === "1"
        ? response({
            data: Array.from({ length: 100 }, (_, index) => ({ id: pageChannelId(index + 1) })),
            meta: channelMeta(1, 101),
          })
        : response({
            data: [{ id: pageChannelId(100) }],
            meta: channelMeta(2, 101),
          });
    },
  });

  await assert.rejects(
    transport.listChannels(PROPERTY_ID),
    (error: unknown) =>
      error instanceof ChannexReadonlyTransportError &&
      error.code === "OTA_READONLY_PROVIDER_RESPONSE_INVALID"
  );
});

test("GET channel uses the exact resource id", async () => {
  const calls: any[] = [];
  const transport = createChannexReadonlyHttpTransport({
    apiOrigin: "https://staging.channex.io",
    apiKey: "secret",
    timeoutMs: 1000,
    fetchImpl: async (input, init) => {
      calls.push({ url: String(input), init });
      return response({ data: { type: "channel", id: CHANNEL_ID } });
    },
  });

  await transport.getChannel(CHANNEL_ID);
  assert.equal(
    calls[0].url,
    `https://staging.channex.io/api/v1/channels/${CHANNEL_ID}`
  );
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[0].init.headers["user-api-key"], "secret");
  assert.equal("body" in calls[0].init, false);
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
  assert.throws(
    () => transport.getChannel("../secrets"),
    (e: unknown) =>
      e instanceof ChannexReadonlyTransportError &&
      e.code === "OTA_READONLY_CHANNEL_ID_INVALID"
  );
  assert.throws(
    () => transport.getRoomType("room-not-uuid"),
    (e: unknown) =>
      e instanceof ChannexReadonlyTransportError &&
      e.code === "OTA_READONLY_ROOM_TYPE_ID_INVALID"
  );
  assert.throws(
    () => transport.getRatePlan("rate-not-uuid"),
    (e: unknown) =>
      e instanceof ChannexReadonlyTransportError &&
      e.code === "OTA_READONLY_RATE_PLAN_ID_INVALID"
  );
  assert.throws(
    () => transport.listChannels(PROPERTY_ID, "Airbnb&filter[is_active]=true"),
    (e: unknown) =>
      e instanceof ChannexReadonlyTransportError &&
      e.code === "OTA_READONLY_CHANNEL_FILTER_INVALID"
  );
});
