import assert from "node:assert/strict";
import test from "node:test";

import {
  AirbnbHostConfirmedMappingTransportError,
  createAirbnbHostConfirmedMappingHttpTransport,
} from "./airbnb-host-confirmed-mapping.http-transport.js";

const CHANNEL_ID = "04ef2057-cca7-4e28-be54-f991f461a1cd";
const RATE_PLAN_ID = "bfd7dfe7-0c6d-4145-bbc4-45546780d720";
const LISTING_ID = "551126434553599406";
const MAPPING_ID = "11111111-1111-4111-8111-111111111111";

function documentedResponse() {
  return {
    data: {
      type: "channel_rate_plan",
      id: CHANNEL_ID,
      attributes: {
        id: MAPPING_ID,
        settings: {
          listing_id: LISTING_ID,
          published: false,
          sync_category: "pending",
        },
      },
      relationships: {
        channel: { data: { id: CHANNEL_ID, type: "channel" } },
      },
    },
  };
}

test("uses exactly the documented Airbnb mapping POST and body", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const transport = createAirbnbHostConfirmedMappingHttpTransport({
    apiOrigin: "https://app.channex.io",
    apiKey: "test-key",
    timeoutMs: 5_000,
    fetchImpl: async (input, init) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify(documentedResponse()), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });

  const result = await transport.createMapping({
    channelId: CHANNEL_ID,
    ratePlanId: RATE_PLAN_ID,
    listingId: LISTING_ID,
  });

  assert.deepEqual(result, documentedResponse());
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0]!.url,
    `https://app.channex.io/api/v1/channels/${CHANNEL_ID}/mappings`
  );
  assert.equal(calls[0]!.init?.method, "POST");
  assert.equal(
    (calls[0]!.init?.headers as Record<string, string>)["user-api-key"],
    "test-key"
  );
  assert.deepEqual(JSON.parse(String(calls[0]!.init?.body)), {
    mapping: {
      rate_plan_id: RATE_PLAN_ID,
      settings: { listing_id: LISTING_ID },
    },
  });
});

test("rejects unsafe identifiers before provider access", async () => {
  let calls = 0;
  const transport = createAirbnbHostConfirmedMappingHttpTransport({
    apiOrigin: "https://app.channex.io",
    apiKey: "test-key",
    timeoutMs: 5_000,
    fetchImpl: async () => {
      calls += 1;
      return new Response("{}");
    },
  });

  for (const input of [
    { channelId: "../activate", ratePlanId: RATE_PLAN_ID, listingId: LISTING_ID },
    { channelId: CHANNEL_ID, ratePlanId: "../rate-plan", listingId: LISTING_ID },
    { channelId: CHANNEL_ID, ratePlanId: RATE_PLAN_ID, listingId: "../listing" },
  ]) {
    await assert.rejects(
      transport.createMapping(input),
      (error: unknown) => error instanceof AirbnbHostConfirmedMappingTransportError
    );
  }
  assert.equal(calls, 0);
});

test("classifies documented provider failures without retrying", async () => {
  for (const [status, code, disposition] of [
    [404, "OTA_AIRBNB_MAPPING_RESOURCE_NOT_FOUND", "SAFE_RETRY"],
    [422, "OTA_AIRBNB_MAPPING_REQUEST_REJECTED", "SAFE_RETRY"],
    [429, "OTA_AIRBNB_MAPPING_RATE_LIMITED", "SAFE_RETRY"],
    [503, "OTA_AIRBNB_MAPPING_RECONCILIATION_REQUIRED", "RECONCILIATION_REQUIRED"],
  ] as const) {
    let calls = 0;
    const transport = createAirbnbHostConfirmedMappingHttpTransport({
      apiOrigin: "https://app.channex.io",
      apiKey: "test-key",
      timeoutMs: 5_000,
      fetchImpl: async () => {
        calls += 1;
        return new Response("{}", { status });
      },
    });
    await assert.rejects(
      transport.createMapping({
        channelId: CHANNEL_ID,
        ratePlanId: RATE_PLAN_ID,
        listingId: LISTING_ID,
      }),
      (error: unknown) => {
        assert.ok(error instanceof AirbnbHostConfirmedMappingTransportError);
        assert.equal(error.code, code);
        assert.equal(error.retryDisposition, disposition);
        assert.equal(error.providerStatus, status);
        return true;
      }
    );
    assert.equal(calls, 1);
  }
});

test("treats ambiguous network or malformed success responses as reconciliation required", async () => {
  const network = createAirbnbHostConfirmedMappingHttpTransport({
    apiOrigin: "https://app.channex.io",
    apiKey: "test-key",
    timeoutMs: 5_000,
    fetchImpl: async () => {
      throw new Error("network-secret");
    },
  });
  await assert.rejects(
    network.createMapping({
      channelId: CHANNEL_ID,
      ratePlanId: RATE_PLAN_ID,
      listingId: LISTING_ID,
    }),
    (error: unknown) =>
      error instanceof AirbnbHostConfirmedMappingTransportError &&
      error.code === "OTA_AIRBNB_MAPPING_RECONCILIATION_REQUIRED" &&
      error.retryDisposition === "RECONCILIATION_REQUIRED"
  );

  const malformed = createAirbnbHostConfirmedMappingHttpTransport({
    apiOrigin: "https://app.channex.io",
    apiKey: "test-key",
    timeoutMs: 5_000,
    fetchImpl: async () => new Response("not-json", { status: 200 }),
  });
  await assert.rejects(
    malformed.createMapping({
      channelId: CHANNEL_ID,
      ratePlanId: RATE_PLAN_ID,
      listingId: LISTING_ID,
    }),
    (error: unknown) =>
      error instanceof AirbnbHostConfirmedMappingTransportError &&
      error.code === "OTA_AIRBNB_MAPPING_RESPONSE_INVALID" &&
      error.retryDisposition === "RECONCILIATION_REQUIRED"
  );
});
