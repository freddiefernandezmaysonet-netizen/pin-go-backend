import assert from "node:assert/strict";
import test from "node:test";
import axios from "axios";
import { prisma } from "../lib/prisma";
import {
  configureChannexBookingWebhookForLive,
  normalizeChannexLiveBaseUrl,
  normalizeChannexLiveWebhookCallbackUrl,
  runChannexLiveBookingWebhookCommand,
} from "./configure-channex-live-booking-webhook";
import { configureChannexBookingWebhookForLive as sharedRegistrar } from "../services/channex-booking-webhook-registration.service";

const callbackUrl = "https://api.pin-ngo.com/webhooks/channex";
const env = Object.freeze({
  CHANNEX_LIVE_WEBHOOK_CONFIRMATION: "CONFIGURE_CHANNEX_LIVE_WEBHOOK",
  PIN_GO_PROPERTY_ID: "pin-property-live",
  OTA_CONNECTION_API_KEY: "ota-command-test-key",
  OTA_CONNECTION_PROVIDER_API_ORIGIN: "https://app.channex.io",
  CHANNEX_API_KEY: "legacy-key-must-not-be-used",
  CHANNEX_API_BASE_URL: "https://staging.channex.io",
  CHANNEX_WEBHOOK_CALLBACK_URL: "https://wrong.example/webhooks/channex",
});

function result(): Awaited<ReturnType<typeof sharedRegistrar>> {
  return {
    ok: true, provider: "PIN_GO_CONNECT", environment: "LIVE", operation: "CREATED",
    propertyId: env.PIN_GO_PROPERTY_ID, channexPropertyId: "external-property",
    webhookId: "webhook-live", callbackUrl, eventMask: "booking", sendData: false,
    isActive: true, secretCreated: false, verified: true,
  };
}

test("live command re-exports the shared registrar rather than a duplicated implementation", () => {
  assert.equal(configureChannexBookingWebhookForLive, sharedRegistrar);
});

test("normalizeChannexLiveBaseUrl accepts only the canonical productive origin", () => {
  assert.equal(normalizeChannexLiveBaseUrl("https://app.channex.io/"), "https://app.channex.io");
  assert.equal(normalizeChannexLiveBaseUrl("https://app.channex.io"), "https://app.channex.io");
});

for (const [url, code] of [
  ["https://api.channex.io", "CHANNEX_PRODUCTION_OTA_ORIGIN_REQUIRED"],
  ["https://channex.io", "CHANNEX_PRODUCTION_OTA_ORIGIN_REQUIRED"],
  ["https://staging.channex.io", "CHANNEX_LIVE_WEBHOOK_REJECTS_STAGING"],
  ["https://example.com", "CHANNEX_PRODUCTION_OTA_ORIGIN_REQUIRED"],
  ["http://app.channex.io", "CHANNEX_LIVE_WEBHOOK_REQUIRES_HTTPS"],
  ["https://app.channex.io:8443", "CHANNEX_PRODUCTION_OTA_ORIGIN_REQUIRED"],
  ["https://app.channex.io/api/v1", "CHANNEX_PRODUCTION_OTA_ORIGIN_REQUIRED"],
  ["https://user:secret@app.channex.io", "CHANNEX_PRODUCTION_OTA_ORIGIN_REQUIRED"],
  ["https://app.channex.io?token=1", "CHANNEX_PRODUCTION_OTA_ORIGIN_REQUIRED"],
  ["https://app.channex.io#fragment", "CHANNEX_PRODUCTION_OTA_ORIGIN_REQUIRED"],
  ["not-a-url", "CHANNEX_PRODUCTION_OTA_ORIGIN_REQUIRED"],
]) {
  test(`live origin normalization rejects ${url}`, () => {
    assert.throws(() => normalizeChannexLiveBaseUrl(url!), new RegExp(code!));
  });
}

test("live callback must be exactly the productive booking webhook route", () => {
  assert.equal(normalizeChannexLiveWebhookCallbackUrl(callbackUrl), callbackUrl);
  for (const invalid of [
    "http://api.pin-ngo.com/webhooks/channex", "https://staging.pin-ngo.com/webhooks/channex",
    "https://api.pin-ngo.com/webhooks/not-channex", "https://api.pin-ngo.com/prefix/webhooks/channex",
    `${callbackUrl}?other=1`, `${callbackUrl}#fragment`, `${callbackUrl}/`,
    "https://user:pass@api.pin-ngo.com/webhooks/channex", "https://api.pin-ngo.com:8443/webhooks/channex",
  ]) {
    assert.throws(() => normalizeChannexLiveWebhookCallbackUrl(invalid), /CHANNEX_(?:WEBHOOK_CALLBACK|LIVE_WEBHOOK_CALLBACK)_/);
  }
});

for (const confirmation of [undefined, "", "yes", "CONFIGURE_CHANNEX_STAGING_WEBHOOK"]) {
  test(`command rejects missing or invalid live confirmation: ${String(confirmation)}`, async () => {
    let calls = 0;
    await assert.rejects(runChannexLiveBookingWebhookCommand({
      env: { ...env, CHANNEX_LIVE_WEBHOOK_CONFIRMATION: confirmation },
      configure: async () => { calls++; return result(); },
    }), /CHANNEX_LIVE_WEBHOOK_CONFIRMATION_(?:REQUIRED|INVALID)/);
    assert.equal(calls, 0);
  });
}

test("command requires a property before invoking the registrar", async () => {
  let calls = 0;
  await assert.rejects(runChannexLiveBookingWebhookCommand({
    env: { ...env, PIN_GO_PROPERTY_ID: " " },
    configure: async () => { calls++; return result(); },
  }), /PIN_GO_PROPERTY_ID_REQUIRED/);
  assert.equal(calls, 0);
});

test("confirmed command forwards the property and read-only configuration, not legacy transport arguments", async () => {
  const before = { ...env };
  let calls = 0;
  const output = await runChannexLiveBookingWebhookCommand({
    env,
    configure: async (input) => {
      calls++;
      assert.deepEqual(Object.keys(input).sort(), ["env", "propertyId"]);
      assert.equal(input.propertyId, env.PIN_GO_PROPERTY_ID);
      assert.equal(input.env, env);
      return result();
    },
  });
  assert.equal(calls, 1);
  assert.equal(output.verified, true);
  assert.deepEqual(env, before);
});

test("default live command rejects legacy-only credentials even without NODE_ENV", async () => {
  await assert.rejects(runChannexLiveBookingWebhookCommand({
    env: { ...env, OTA_CONNECTION_API_KEY: undefined },
  }), /CHANNEX_PRODUCTION_OTA_API_KEY_REQUIRED/);
  await assert.rejects(runChannexLiveBookingWebhookCommand({
    env: { ...env, OTA_CONNECTION_PROVIDER_API_ORIGIN: undefined },
  }), /CHANNEX_PRODUCTION_OTA_ORIGIN_REQUIRED/);
});

test("default live command uses the shared productive registrar with mocked persistence and transport", async () => {
  const prismaAny = prisma as any;
  const axiosAny = axios as any;
  const originals = {
    findMany: prismaAny.pmsListing.findMany, update: prismaAny.pmsListing.update,
    updateConnection: prismaAny.pmsConnection.update,
    post: axiosAny.post, put: axiosAny.put, get: axiosAny.get,
  };
  const methods: string[] = [];
  const verified: boolean[] = [];
  prismaAny.pmsListing.findMany = async (input: any) => {
    assert.equal(input.where.propertyId, env.PIN_GO_PROPERTY_ID);
    return [{
      id: "listing-live", metadata: { channexPropertyId: "external-property" },
      connection: { id: "connection-live", webhookSecret: "existing-test-secret" },
    }];
  };
  prismaAny.pmsListing.update = async (input: any) => {
    verified.push(input.data.metadata.channexBookingWebhookVerified);
    return input;
  };
  prismaAny.pmsConnection.update = async () => { throw new Error("unexpected secret mutation"); };
  axiosAny.put = async () => { throw new Error("unexpected PUT"); };
  axiosAny.post = async (url: string, payload: any, options: any) => {
    methods.push("POST");
    assert.equal(url, "https://app.channex.io/api/v1/webhooks");
    assert.equal(options.headers["user-api-key"], env.OTA_CONNECTION_API_KEY);
    assert.equal(options.maxRedirects, 0);
    assert.equal(payload.webhook.callback_url, callbackUrl);
    assert.equal(payload.webhook.event_mask, "booking");
    assert.equal(payload.webhook.send_data, false);
    assert.equal(payload.webhook.property_id, "external-property");
    return { data: { data: { id: "webhook-live" } } };
  };
  axiosAny.get = async (url: string, options: any) => {
    methods.push("GET");
    assert.equal(url, "https://app.channex.io/api/v1/webhooks/webhook-live");
    assert.equal(options.headers["user-api-key"], env.OTA_CONNECTION_API_KEY);
    assert.equal(options.maxRedirects, 0);
    return { data: { data: { id: "webhook-live", attributes: {
      property_id: "external-property", callback_url: callbackUrl,
      event_mask: "booking", send_data: false, is_active: true,
    } } } };
  };
  try {
    const output = await runChannexLiveBookingWebhookCommand({ env });
    assert.equal(output.environment, "LIVE");
    assert.equal(output.verified, true);
    assert.deepEqual(methods, ["POST", "GET"]);
    assert.deepEqual(verified, [false, true]);
  } finally {
    prismaAny.pmsListing.findMany = originals.findMany;
    prismaAny.pmsListing.update = originals.update;
    prismaAny.pmsConnection.update = originals.updateConnection;
    axiosAny.post = originals.post; axiosAny.put = originals.put; axiosAny.get = originals.get;
  }
});
