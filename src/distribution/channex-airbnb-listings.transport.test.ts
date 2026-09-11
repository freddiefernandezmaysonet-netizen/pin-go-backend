import assert from "node:assert/strict";
import test from "node:test";

import {
  ChannexReadonlyTransportError,
  createChannexReadonlyHttpTransport,
} from "./channex-readonly.http-transport.js";

const CHANNEL_ID = "44444444-4444-4444-8444-444444444444";

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("Airbnb listing discovery uses the documented channel-scoped GET with no body", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const documentedPayload = {
    data: {
      listing_id_dictionary: {
        values: [
          {
            id: "42544559",
            title: "Test Property · Test Channex Property",
            type: "apartment",
            occupancies: [1, 2, 3, 4],
            synchronization_category: "text",
            city: "text",
            country_code: "DE",
            quality_status: "text",
          },
        ],
      },
    },
  };
  const transport = createChannexReadonlyHttpTransport({
    apiOrigin: "https://app.channex.io",
    apiKey: "secret",
    timeoutMs: 1000,
    fetchImpl: async (input, init) => {
      calls.push({ url: String(input), init });
      return response(documentedPayload);
    },
  });

  const result = await transport.listAirbnbListings(CHANNEL_ID);

  assert.deepEqual(result, documentedPayload);
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    `https://app.channex.io/api/v1/channels/${CHANNEL_ID}/action/listings`
  );
  assert.equal(calls[0].init?.method, "GET");
  assert.equal((calls[0].init?.headers as Record<string, string>)["user-api-key"], "secret");
  assert.equal("body" in (calls[0].init ?? {}), false);
});

test("Airbnb listing discovery rejects unsafe channel ids before provider access", async () => {
  let calls = 0;
  const transport = createChannexReadonlyHttpTransport({
    apiOrigin: "https://app.channex.io",
    apiKey: "secret",
    timeoutMs: 1000,
    fetchImpl: async () => {
      calls += 1;
      return response({});
    },
  });

  assert.throws(
    () => transport.listAirbnbListings("../secrets"),
    (error: unknown) =>
      error instanceof ChannexReadonlyTransportError &&
      error.code === "OTA_READONLY_CHANNEL_ID_INVALID"
  );
  assert.equal(calls, 0);
});
