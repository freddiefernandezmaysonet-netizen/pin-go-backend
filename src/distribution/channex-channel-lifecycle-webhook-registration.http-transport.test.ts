import assert from "node:assert/strict";
import test from "node:test";

import { createChannexChannelLifecycleWebhookRegistrationHttpTransport } from "./channex-channel-lifecycle-webhook-registration.http-transport.js";
import { buildChannexChannelLifecycleWebhookPayload } from "./channex-channel-lifecycle-webhook.contract.js";

const propertyId = "faf0559d-965f-426c-8303-107b0b1bc5ff";
const webhookId = "11111111-1111-4111-8111-111111111111";
const callbackUrl = "https://api.pin-ngo.com/webhooks/ota/channex/channel-lifecycle";

function response(id = webhookId) {
  return { data: { id, type: "webhook", attributes: {
    callback_url: callbackUrl,
    event_mask: "new_channel;updated_channel;activate_channel;deactivate_channel;disconnect_channel;disconnect_listing",
    headers: { "x-pin-go-ota-channel-webhook-secret": "secret" },
    is_active: true, send_data: true, protected: false, is_global: false,
  }, relationships: { property: { data: { id: propertyId, type: "property" } } } },
  meta: { page: 1, limit: 100, total: 1 } };
}

test("HTTP transport is production-only and sends only the canonical API key header", async () => {
  assert.throws(() => createChannexChannelLifecycleWebhookRegistrationHttpTransport({
    apiOrigin: "https://staging.channex.io", apiKey: "key", timeoutMs: 1000,
  }), /PRODUCTION_ORIGIN_REQUIRED/);
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const transport = createChannexChannelLifecycleWebhookRegistrationHttpTransport({
    apiOrigin: "https://app.channex.io", apiKey: "canonical-key", timeoutMs: 1000,
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init: init! });
      const payload = response();
      return Response.json(String(url).includes("pagination")
        ? { ...payload, data: [payload.data] }
        : payload);
    },
  });
  await transport.listAllWebhooks();
  await transport.getWebhook(webhookId);
  const headers = calls[0]!.init.headers as Record<string, string>;
  assert.equal(headers["user-api-key"], "canonical-key");
  assert.equal(Object.keys(headers).some((name) => /legacy|channex-api/i.test(name)), false);
  assert.equal(calls.every((call) => call.url.startsWith("https://app.channex.io/api/v1/webhooks")), true);
  assert.match(calls[0]!.url, /pagination%5Bpage%5D=1&pagination%5Blimit%5D=100/);
});

test("HTTP transport follows exact pagination and rejects inconsistent totals", async () => {
  let page = 0;
  const transport = createChannexChannelLifecycleWebhookRegistrationHttpTransport({
    apiOrigin: "https://app.channex.io", apiKey: "key", timeoutMs: 1000,
    fetchImpl: async () => {
      page++;
      const count = page === 1 ? 100 : 1;
      return Response.json({
        data: Array.from({ length: count }, (_, index) => ({
          ...response(`${String(page).padStart(8, "0")}-1111-4111-8111-${String(index).padStart(12, "0")}`).data,
          id: `${String(page).padStart(8, "0")}-1111-4111-8111-${String(index).padStart(12, "0")}`,
        })),
        meta: { page, limit: 100, total: 101 },
      });
    },
  });
  assert.equal((await transport.listAllWebhooks()).length, 101);

  const invalid = createChannexChannelLifecycleWebhookRegistrationHttpTransport({
    apiOrigin: "https://app.channex.io", apiKey: "key", timeoutMs: 1000,
    fetchImpl: async () => Response.json({ data: [], meta: { page: 1, limit: 100, total: 1 } }),
  });
  await assert.rejects(invalid.listAllWebhooks(), /LIST_RESPONSE_INVALID/);
});

test("HTTP transport posts the exact lifecycle payload and parses the created id", async () => {
  let posted: unknown;
  const transport = createChannexChannelLifecycleWebhookRegistrationHttpTransport({
    apiOrigin: "https://app.channex.io", apiKey: "key", timeoutMs: 1000,
    fetchImpl: async (_url, init) => {
      posted = JSON.parse(String(init?.body));
      return Response.json(response(), { status: 201 });
    },
  });
  const payload = buildChannexChannelLifecycleWebhookPayload({
    externalPropertyId: propertyId, callbackUrl, webhookSecret: "secret",
  });
  assert.equal(await transport.postWebhook(payload), webhookId);
  assert.deepEqual(posted, payload);
});

test("HTTP transport rejects malformed create responses without leaking the API key", async () => {
  const transport = createChannexChannelLifecycleWebhookRegistrationHttpTransport({
    apiOrigin: "https://app.channex.io", apiKey: "do-not-leak", timeoutMs: 1000,
    fetchImpl: async () => Response.json({ data: { id: "opaque" } }, { status: 201 }),
  });
  await assert.rejects(
    transport.postWebhook(buildChannexChannelLifecycleWebhookPayload({
      externalPropertyId: propertyId, callbackUrl, webhookSecret: "secret",
    })),
    (error: any) => error.message === "OTA_CHANNEL_LIFECYCLE_WEBHOOK_CREATE_RESPONSE_INVALID" &&
      !JSON.stringify(error).includes("do-not-leak")
  );
});
