import assert from "node:assert/strict";
import test from "node:test";
import axios from "axios";
import { prisma } from "../lib/prisma";
import {
  assertVerifiedChannexWebhook,
  buildChannexBookingWebhookPayload,
  configureChannexBookingWebhookForStaging,
  configureChannexBookingWebhookForLive,
  configureChannexBookingWebhookForConnectionCenter,
  CHANNEX_PRODUCTION_WEBHOOK_CALLBACK_URL,
  normalizeChannexStagingBaseUrl,
  normalizeChannexWebhookCallbackUrl,
} from "./channex-booking-webhook-registration.service";

const callbackUrl = "https://api-staging.example.com/webhooks/channex";
const apiBaseUrl = "https://staging.channex.io";
const channexPropertyId = "property-001";
const webhookSecret = "secret-value";

function webhookResponse(webhookId: string) {
  return {
    data: {
      id: webhookId,
      type: "webhook",
      attributes: {
        callback_url: callbackUrl,
        event_mask: "booking",
        is_active: true,
        send_data: false,
      },
      relationships: {
        property: {
          data: {
            id: channexPropertyId,
            type: "property",
          },
        },
      },
    },
  };
}

function listing(args: {
  id: string;
  externalListingId: string;
  webhookId?: string;
}) {
  return {
    id: args.id,
    propertyId: "pin-property-001",
    externalListingId: args.externalListingId,
    metadata: {
      channexPropertyId,
      ...(args.webhookId
        ? { channexBookingWebhookId: args.webhookId }
        : {}),
    },
    connection: {
      id: "connection-001",
      webhookSecret,
    },
  };
}

async function withRegistrationMocks<T>(args: {
  listings: ReturnType<typeof listing>[];
  axiosPost: (...values: any[]) => Promise<any>;
  axiosPut: (...values: any[]) => Promise<any>;
  axiosGet: (...values: any[]) => Promise<any>;
  run: (updates: any[]) => Promise<T>;
}) {
  const prismaAny = prisma as any;
  const axiosAny = axios as any;
  const originals = {
    findMany: prismaAny.pmsListing.findMany,
    updateListing: prismaAny.pmsListing.update,
    updateConnection: prismaAny.pmsConnection.update,
    post: axiosAny.post,
    put: axiosAny.put,
    get: axiosAny.get,
  };
  const updates: any[] = [];

  prismaAny.pmsListing.findMany = async () => args.listings;
  prismaAny.pmsListing.update = async (input: any) => {
    updates.push(input);
    return input;
  };
  prismaAny.pmsConnection.update = async () => {
    throw new Error("connection secret should already exist in this test");
  };
  axiosAny.post = args.axiosPost;
  axiosAny.put = args.axiosPut;
  axiosAny.get = args.axiosGet;

  try {
    return await args.run(updates);
  } finally {
    prismaAny.pmsListing.findMany = originals.findMany;
    prismaAny.pmsListing.update = originals.updateListing;
    prismaAny.pmsConnection.update = originals.updateConnection;
    axiosAny.post = originals.post;
    axiosAny.put = originals.put;
    axiosAny.get = originals.get;
  }
}

test("registration accepts only the official Channex staging host", () => {
  assert.equal(
    normalizeChannexStagingBaseUrl("https://staging.channex.io/"),
    "https://staging.channex.io"
  );

  assert.throws(
    () => normalizeChannexStagingBaseUrl("https://app.channex.io"),
    /CHANNEX_WEBHOOK_REGISTRATION_REQUIRES_STAGING/
  );

  assert.throws(
    () => normalizeChannexStagingBaseUrl("http://staging.channex.io"),
    /CHANNEX_WEBHOOK_REGISTRATION_REQUIRES_STAGING/
  );
});

test("callback must be HTTPS and target the global Channex route", () => {
  assert.equal(
    normalizeChannexWebhookCallbackUrl(callbackUrl),
    callbackUrl
  );

  assert.throws(
    () =>
      normalizeChannexWebhookCallbackUrl(
        "http://api.example.com/webhooks/channex"
      ),
    /CHANNEX_WEBHOOK_CALLBACK_REQUIRES_HTTPS/
  );

  assert.throws(
    () =>
      normalizeChannexWebhookCallbackUrl(
        "https://api.example.com/webhooks/other"
      ),
    /CHANNEX_WEBHOOK_CALLBACK_PATH_INVALID/
  );
});

test("booking webhook payload is pull-trigger only and authenticated", () => {
  const payload = buildChannexBookingWebhookPayload({
    channexPropertyId,
    callbackUrl,
    webhookSecret,
  });

  assert.deepEqual(payload, {
    webhook: {
      property_id: channexPropertyId,
      callback_url: callbackUrl,
      event_mask: "booking",
      headers: {
        "x-pin-go-webhook-secret": webhookSecret,
      },
      is_active: true,
      send_data: false,
    },
  });
});

test("verification accepts the property relationship returned by Channex", () => {
  assert.doesNotThrow(() =>
    assertVerifiedChannexWebhook({
      responseData: webhookResponse("webhook-001"),
      webhookId: "webhook-001",
      callbackUrl,
      channexPropertyId,
    })
  );
});

test("verification preserves property_id attribute compatibility", () => {
  const response = webhookResponse("webhook-001");
  delete (response.data as any).relationships;
  (response.data.attributes as any).property_id = channexPropertyId;

  assert.doesNotThrow(() =>
    assertVerifiedChannexWebhook({
      responseData: response,
      webhookId: "webhook-001",
      callbackUrl,
      channexPropertyId,
    })
  );
});

test("verification requires the complete webhook representation", () => {
  assert.throws(
    () =>
      assertVerifiedChannexWebhook({
        responseData: { data: { id: "webhook-001", attributes: {} } },
        webhookId: "webhook-001",
        callbackUrl,
        channexPropertyId,
      }),
    /CHANNEX_WEBHOOK_VERIFICATION_CALLBACK_MISSING/
  );

  assert.throws(
    () =>
      assertVerifiedChannexWebhook({
        responseData: webhookResponse("webhook-other"),
        webhookId: "webhook-001",
        callbackUrl,
        channexPropertyId,
      }),
    /CHANNEX_WEBHOOK_VERIFICATION_ID_MISMATCH/
  );

  const sendDataMissing = webhookResponse("webhook-001");
  delete (sendDataMissing.data.attributes as any).send_data;

  assert.throws(
    () =>
      assertVerifiedChannexWebhook({
        responseData: sendDataMissing,
        webhookId: "webhook-001",
        callbackUrl,
        channexPropertyId,
      }),
    /CHANNEX_WEBHOOK_VERIFICATION_SEND_DATA_ENABLED/
  );
});

test("creation uses POST, verifies with GET and updates every listing", async () => {
  const postCalls: any[] = [];
  const getCalls: any[] = [];

  await withRegistrationMocks({
    listings: [
      listing({ id: "listing-1", externalListingId: "room-1" }),
      listing({ id: "listing-2", externalListingId: "room-2" }),
    ],
    axiosPost: async (...values: any[]) => {
      postCalls.push(values);
      return { data: webhookResponse("webhook-001") };
    },
    axiosPut: async () => {
      throw new Error("PUT must not be called when no webhook ID exists");
    },
    axiosGet: async (...values: any[]) => {
      getCalls.push(values);
      return { data: webhookResponse("webhook-001") };
    },
    run: async (updates) => {
      const result = await configureChannexBookingWebhookForStaging({
        propertyId: "pin-property-001",
        callbackUrl,
        apiKey: "test-api-key",
        apiBaseUrl,
      });

      assert.equal(result.operation, "CREATED");
      assert.equal(result.webhookId, "webhook-001");
      assert.equal(result.verified, true);
      assert.equal(postCalls.length, 1);
      assert.equal(postCalls[0][0], `${apiBaseUrl}/api/v1/webhooks`);
      assert.deepEqual(
        postCalls[0][1],
        buildChannexBookingWebhookPayload({
          channexPropertyId,
          callbackUrl,
          webhookSecret,
        })
      );
      assert.equal(postCalls[0][2].headers["user-api-key"], "test-api-key");
      assert.equal(getCalls.length, 1);
      assert.equal(
        getCalls[0][0],
        `${apiBaseUrl}/api/v1/webhooks/webhook-001`
      );

      assert.equal(updates.length, 4);
      assert.deepEqual(
        updates.map((update) => update.where.id),
        ["listing-1", "listing-2", "listing-1", "listing-2"]
      );
      assert.deepEqual(
        updates.map(
          (update) => update.data.metadata.channexBookingWebhookVerified
        ),
        [false, false, true, true]
      );
    },
  });
});

test("existing registration uses PUT and does not create a duplicate", async () => {
  const putCalls: any[] = [];
  let postCalled = false;

  await withRegistrationMocks({
    listings: [
      listing({
        id: "listing-1",
        externalListingId: "room-1",
        webhookId: "webhook-001",
      }),
      listing({
        id: "listing-2",
        externalListingId: "room-2",
        webhookId: "webhook-001",
      }),
    ],
    axiosPost: async () => {
      postCalled = true;
      throw new Error("POST must not be called for an existing webhook");
    },
    axiosPut: async (...values: any[]) => {
      putCalls.push(values);
      return { data: webhookResponse("webhook-001") };
    },
    axiosGet: async () => ({
      data: webhookResponse("webhook-001"),
    }),
    run: async (updates) => {
      const result = await configureChannexBookingWebhookForStaging({
        propertyId: "pin-property-001",
        callbackUrl,
        apiKey: "test-api-key",
        apiBaseUrl,
      });

      assert.equal(result.operation, "UPDATED");
      assert.equal(postCalled, false);
      assert.equal(putCalls.length, 1);
      assert.equal(
        putCalls[0][0],
        `${apiBaseUrl}/api/v1/webhooks/webhook-001`
      );
      assert.equal(putCalls[0][2].headers["user-api-key"], "test-api-key");
      assert.equal(updates.length, 4);
      assert.deepEqual(
        updates.map(
          (update) => update.data.metadata.channexBookingWebhookVerified
        ),
        [false, false, true, true]
      );
    },
  });
});


const liveEnv = Object.freeze({
  NODE_ENV: "production",
  OTA_CONNECTION_API_KEY: "ota-production-test-key",
  OTA_CONNECTION_PROVIDER_API_ORIGIN: "https://app.channex.io",
  CHANNEX_API_KEY: "legacy-key-must-not-be-used",
  CHANNEX_API_BASE_URL: "https://staging.channex.io",
  CHANNEX_WEBHOOK_CALLBACK_URL: "https://wrong.example/webhooks/channex",
});

function liveResponse(id = "webhook-live") {
  const response = webhookResponse(id);
  response.data.attributes.callback_url = CHANNEX_PRODUCTION_WEBHOOK_CALLBACK_URL;
  return response;
}

function liveListing(webhookId?: string) {
  return {
    ...listing({ id: "listing-live", externalListingId: "room-live", webhookId }),
    connection: { id: "connection-001", organizationId: "org-001", webhookSecret },
  };
}

async function withLiveMocks(run: (state: {
  listings: any[];
  calls: Array<{ method: string; url: string; payload?: any; options: any }>;
  queries: any[];
  updates: any[];
  secretUpdates: any[];
  response: any;
  postError?: unknown;
  putError?: unknown;
  getError?: unknown;
}) => Promise<void>) {
  const prismaAny = prisma as any;
  const axiosAny = axios as any;
  const originals = {
    findMany: prismaAny.pmsListing.findMany,
    update: prismaAny.pmsListing.update,
    updateConnection: prismaAny.pmsConnection.update,
    updateManyConnection: prismaAny.pmsConnection.updateMany,
    findConnection: prismaAny.pmsConnection.findUnique,
    post: axiosAny.post,
    put: axiosAny.put,
    get: axiosAny.get,
  };
  const state: Parameters<typeof run>[0] = {
    listings: [liveListing()], calls: [], queries: [], updates: [],
    secretUpdates: [], response: liveResponse(),
  };
  prismaAny.pmsListing.findMany = async (args: any) => {
    state.queries.push(args);
    return state.listings;
  };
  prismaAny.pmsListing.update = async (args: any) => {
    state.updates.push(args);
    const found = state.listings.find((item) => item.id === args.where.id);
    if (found) found.metadata = args.data.metadata;
    return args;
  };
  prismaAny.pmsConnection.update = async () => {
    throw new Error("unconditional shared-secret mutation is forbidden");
  };
  prismaAny.pmsConnection.updateMany = async (args: any) => {
    state.secretUpdates.push(args);
    const connection = state.listings[0]?.connection;
    if (!connection || connection.webhookSecret !== args.where.webhookSecret) return { count: 0 };
    for (const item of state.listings) item.connection.webhookSecret = args.data.webhookSecret;
    return { count: 1 };
  };
  prismaAny.pmsConnection.findUnique = async () => {
    const connection = state.listings[0]?.connection;
    return connection ? { ...connection, provider: "CHANNEX", status: "ACTIVE" } : null;
  };
  axiosAny.post = async (url: string, payload: any, options: any) => {
    state.calls.push({ method: "POST", url, payload, options });
    if (state.postError) throw state.postError;
    return { data: { data: { id: "webhook-live" } } };
  };
  axiosAny.put = async (url: string, payload: any, options: any) => {
    state.calls.push({ method: "PUT", url, payload, options });
    if (state.putError) throw state.putError;
    return { data: { data: { id: "webhook-live" } } };
  };
  axiosAny.get = async (url: string, options: any) => {
    state.calls.push({ method: "GET", url, options });
    if (state.getError) throw state.getError;
    return { data: state.response };
  };
  try {
    await run(state);
  } finally {
    prismaAny.pmsListing.findMany = originals.findMany;
    prismaAny.pmsListing.update = originals.update;
    prismaAny.pmsConnection.update = originals.updateConnection;
    prismaAny.pmsConnection.updateMany = originals.updateManyConnection;
    prismaAny.pmsConnection.findUnique = originals.findConnection;
    axiosAny.post = originals.post;
    axiosAny.put = originals.put;
    axiosAny.get = originals.get;
  }
}

const registerLive = (env: Readonly<Record<string, string | undefined>> = liveEnv) =>
  configureChannexBookingWebhookForConnectionCenter({
    organizationId: "org-001", propertyId: "pin-property-001", env,
  });

test("production onboarding creates one property-scoped booking webhook with OTA-only transport", async () => {
  await withLiveMocks(async (state) => {
    state.listings[0].metadata.unrelated = "preserve-me";
    const result = await registerLive();
    assert.equal(result.environment, "LIVE");
    assert.equal(result.operation, "CREATED");
    assert.equal(result.verified, true);
    assert.equal(result.sendData, false);
    assert.equal(result.eventMask, "booking");
    assert.equal(result.callbackUrl, CHANNEX_PRODUCTION_WEBHOOK_CALLBACK_URL);
    assert.deepEqual(state.calls.map((call) => call.method), ["POST", "GET"]);
    assert.deepEqual(state.calls[0]!.payload, {
      webhook: {
        property_id: channexPropertyId,
        callback_url: CHANNEX_PRODUCTION_WEBHOOK_CALLBACK_URL,
        event_mask: "booking", send_data: false, is_active: true,
        headers: { "x-pin-go-webhook-secret": webhookSecret },
      },
    });
    assert.equal(state.calls[0]!.url, "https://app.channex.io/api/v1/webhooks");
    assert.equal(state.calls[1]!.url, "https://app.channex.io/api/v1/webhooks/webhook-live");
    for (const call of state.calls) {
      assert.equal(call.options.headers["user-api-key"], liveEnv.OTA_CONNECTION_API_KEY);
      assert.equal(call.options.maxRedirects, 0);
      assert.equal(call.options.timeout, 20_000);
    }
    assert.equal(state.queries[0].where.propertyId, "pin-property-001");
    assert.equal(state.queries[0].where.connection.is.organizationId, "org-001");
    assert.equal(state.queries[0].where.connection.is.status, "ACTIVE");
    assert.equal(state.queries[0].where.connection.is.provider, "CHANNEX");
    assert.deepEqual(state.updates.map((entry) => entry.data.metadata.channexBookingWebhookVerified), [false, true]);
    assert.equal(state.updates[1].data.metadata.unrelated, "preserve-me");
    assert.equal(state.secretUpdates.length, 0);
    assert.equal(JSON.stringify(result).includes(liveEnv.OTA_CONNECTION_API_KEY), false);
    assert.equal(JSON.stringify(result).includes(webhookSecret), false);
    assert.equal(JSON.stringify(state.calls).includes(liveEnv.CHANNEX_API_KEY), false);
  });
});

test("live transport cannot fall back when NODE_ENV is absent or non-production", async () => {
  for (const NODE_ENV of [undefined, "test", "development"]) {
    await withLiveMocks(async (state) => {
      const env = Object.freeze({ ...liveEnv, NODE_ENV });
      const result = await configureChannexBookingWebhookForLive({ propertyId: "pin-property-001", env });
      assert.equal(result.environment, "LIVE");
      assert.equal(state.calls[0]!.options.headers["user-api-key"], liveEnv.OTA_CONNECTION_API_KEY);
      assert.equal(env.NODE_ENV, NODE_ENV);
    });
  }
});

test("Connection Center configured for app.channex.io keeps the production callback even without NODE_ENV", async () => {
  await withLiveMocks(async (state) => {
    await registerLive({ ...liveEnv, NODE_ENV: undefined });
    assert.equal(state.calls[0]!.payload.webhook.callback_url, CHANNEX_PRODUCTION_WEBHOOK_CALLBACK_URL);
  });
});

for (const value of [undefined, "", " ", "bad key", "key\r\nheader", "a".repeat(4097)]) {
  test(`production rejects invalid OTA key before database or HTTP: ${value === undefined ? "missing" : value.length}`, async () => {
    await withLiveMocks(async (state) => {
      await assert.rejects(registerLive({ ...liveEnv, OTA_CONNECTION_API_KEY: value }), /CHANNEX_PRODUCTION_OTA_API_KEY_REQUIRED/);
      assert.equal(state.queries.length, 0);
      assert.equal(state.calls.length, 0);
      assert.equal(state.updates.length, 0);
    });
  });
}

for (const value of [
  undefined, "", "https://staging.channex.io", "https://api.channex.io",
  "https://channex.io", "http://app.channex.io", "https://app.channex.io:8443",
  "https://app.channex.io/api/v1", "https://app.channex.io?key=x",
  "https://app.channex.io#fragment", "https://user:pass@app.channex.io",
  "https://app.channex.io.evil.example", "not-a-url",
]) {
  test(`production rejects a non-exact OTA origin before database or HTTP: ${String(value)}`, async () => {
    await withLiveMocks(async (state) => {
      await assert.rejects(registerLive({ ...liveEnv, OTA_CONNECTION_PROVIDER_API_ORIGIN: value }), /CHANNEX_PRODUCTION_OTA_ORIGIN_REQUIRED/);
      assert.equal(state.queries.length, 0);
      assert.equal(state.calls.length, 0);
    });
  });
}

test("production accepts the official origin with its canonical trailing slash", async () => {
  await withLiveMocks(async (state) => {
    await registerLive({ ...liveEnv, OTA_CONNECTION_PROVIDER_API_ORIGIN: "https://app.channex.io/" });
    assert.equal(state.calls[0]!.url, "https://app.channex.io/api/v1/webhooks");
  });
});

test("Connection Center preserves explicit staging transport without legacy fallback", async () => {
  await withLiveMocks(async (state) => {
    state.response = webhookResponse("webhook-live");
    const env = {
      NODE_ENV: "test", OTA_CONNECTION_API_KEY: "ota-staging-key",
      OTA_CONNECTION_PROVIDER_API_ORIGIN: apiBaseUrl,
      CHANNEX_WEBHOOK_CALLBACK_URL: callbackUrl,
      CHANNEX_API_KEY: "legacy-key", CHANNEX_API_BASE_URL: "https://app.channex.io",
    };
    const result = await registerLive(env);
    assert.equal(result.environment, "STAGING");
    assert.equal(state.calls[0]!.url, `${apiBaseUrl}/api/v1/webhooks`);
    assert.equal(state.calls[0]!.options.headers["user-api-key"], "ota-staging-key");
    assert.equal(state.calls[0]!.payload.webhook.callback_url, callbackUrl);
    const count = state.queries.length;
    await assert.rejects(registerLive({ ...env, OTA_CONNECTION_API_KEY: undefined }), /OTA_CONNECTION_API_KEY_REQUIRED/);
    await assert.rejects(registerLive({ ...env, OTA_CONNECTION_PROVIDER_API_ORIGIN: undefined }), /OTA_CONNECTION_PROVIDER_API_ORIGIN_REQUIRED/);
    assert.equal(state.queries.length, count);
  });
});

test("Connection Center requires a tenant and rejects cross-tenant query results", async () => {
  await withLiveMocks(async (state) => {
    await assert.rejects(configureChannexBookingWebhookForConnectionCenter({
      organizationId: " ", propertyId: "pin-property-001", env: liveEnv,
    }), /CHANNEX_WEBHOOK_ORGANIZATION_ID_REQUIRED/);
    assert.equal(state.queries.length, 0);
    state.listings[0].connection.organizationId = "org-other";
    await assert.rejects(registerLive(), /CHANNEX_WEBHOOK_TENANT_MISMATCH/);
    assert.equal(state.calls.length, 0);
  });
});

for (const [name, listings, error] of [
  ["missing", [], "CHANNEX_PROPERTY_MAPPING_NOT_FOUND"],
  ["missing property id", [{ ...liveListing(), metadata: {} }], "CHANNEX_PROPERTY_ID_MISSING_FROM_LISTING"],
  ["conflicting property ids", [liveListing(), { ...liveListing(), id: "other", metadata: { channexPropertyId: "other" } }], "CHANNEX_PROPERTY_MAPPING_AMBIGUOUS"],
  ["conflicting connection ids", [liveListing(), { ...liveListing(), connection: { ...liveListing().connection, id: "other" } }], "CHANNEX_PROPERTY_MAPPING_AMBIGUOUS"],
  ["conflicting webhook ids", [liveListing("one"), liveListing("two")], "CHANNEX_WEBHOOK_MAPPING_AMBIGUOUS"],
] as const) {
  test(`production rejects ${name} mapping without HTTP`, async () => {
    await withLiveMocks(async (state) => {
      state.listings = [...listings];
      await assert.rejects(registerLive(), new RegExp(error));
      assert.equal(state.calls.length, 0);
    });
  });
}

test("a retry after failed GET reuses the saved webhook id instead of issuing another POST", async () => {
  await withLiveMocks(async (state) => {
    state.getError = new Error("verification unavailable");
    await assert.rejects(registerLive(), /verification unavailable/);
    assert.equal(state.listings[0].metadata.channexBookingWebhookId, "webhook-live");
    assert.equal(state.listings[0].metadata.channexBookingWebhookVerified, false);
    state.getError = undefined;
    const result = await registerLive();
    assert.equal(result.operation, "UPDATED");
    assert.deepEqual(state.calls.map((call) => call.method), ["POST", "GET", "PUT", "GET"]);
    assert.equal(state.listings[0].metadata.channexBookingWebhookVerified, true);
    assert.equal(state.calls[2]!.options.maxRedirects, 0);
  });
});

test("only an explicit 404 on the saved webhook allows recreation", async () => {
  await withLiveMocks(async (state) => {
    state.listings = [liveListing("deleted-webhook")];
    state.putError = { response: { status: 404 } };
    const result = await registerLive();
    assert.equal(result.operation, "RECREATED");
    assert.deepEqual(state.calls.map((call) => call.method), ["PUT", "POST", "GET"]);
    assert.equal(result.webhookId, "webhook-live");
  });
});

for (const status of [401, 403, 429, 500]) {
  test(`PUT failure ${status} never falls back to POST or claims verification`, async () => {
    await withLiveMocks(async (state) => {
      state.listings = [liveListing("webhook-live")];
      state.putError = { response: { status } };
      await assert.rejects(registerLive());
      assert.deepEqual(state.calls.map((call) => call.method), ["PUT"]);
      assert.equal(state.updates.some((entry) => entry.data.metadata.channexBookingWebhookVerified === true), false);
    });
  });
}

for (const [name, change] of [
  ["wrong id", (response: any) => { response.data.id = "other"; }],
  ["wrong property", (response: any) => { response.data.relationships.property.data.id = "other"; }],
  ["missing property", (response: any) => { delete response.data.relationships; }],
  ["wrong callback", (response: any) => { response.data.attributes.callback_url = callbackUrl; }],
  ["wrong mask", (response: any) => { response.data.attributes.event_mask = "booking_new"; }],
  ["missing mask", (response: any) => { delete response.data.attributes.event_mask; }],
  ["send data true", (response: any) => { response.data.attributes.send_data = true; }],
  ["send data string", (response: any) => { response.data.attributes.send_data = "false"; }],
  ["missing send data", (response: any) => { delete response.data.attributes.send_data; }],
  ["inactive", (response: any) => { response.data.attributes.is_active = false; }],
] as const) {
  test(`GET rejects ${name} and never persists verified=true`, async () => {
    await withLiveMocks(async (state) => {
      change(state.response);
      await assert.rejects(registerLive(), /CHANNEX_WEBHOOK_VERIFICATION_/);
      assert.deepEqual(state.calls.map((call) => call.method), ["POST", "GET"]);
      assert.deepEqual(state.updates.map((entry) => entry.data.metadata.channexBookingWebhookVerified), [false]);
    });
  });
}

test("a failed POST is not retried automatically and produces no verified metadata", async () => {
  await withLiveMocks(async (state) => {
    state.postError = new Error("timeout");
    await assert.rejects(registerLive(), /timeout/);
    assert.deepEqual(state.calls.map((call) => call.method), ["POST"]);
    assert.equal(state.updates.length, 0);
  });
});

test("a missing connection secret is saved and used for the property-scoped webhook", async () => {
  await withLiveMocks(async (state) => {
    state.listings[0].connection.webhookSecret = null;
    const result = await registerLive();
    assert.equal(result.secretCreated, true);
    assert.equal(state.secretUpdates.length, 1);
    const generated = state.secretUpdates[0].data.webhookSecret;
    assert.match(generated, /^[a-zA-Z0-9_-]{43}$/);
    assert.equal(state.calls[0]!.payload.webhook.headers["x-pin-go-webhook-secret"], generated);
    assert.equal(JSON.stringify(result).includes(generated), false);
  });
});


async function withSecretInitializationMocks(
  options: {
    simultaneousReads?: number;
    initialSecret?: string | null;
    updateError?: boolean;
    concurrentSecret?: string;
    refreshedConnection?: Record<string, unknown> | null;
    unexpectedCount?: number;
  },
  run: (state: {
    connection: any;
    httpCalls: number;
    unconditionalWrites: number;
    conditionalWrites: any[];
    secretReads: number;
    payloads: any[];
  }) => Promise<void>
) {
  const db = prisma as any;
  const http = axios as any;
  const originals = {
    findMany: db.pmsListing.findMany,
    updateListing: db.pmsListing.update,
    updateConnection: db.pmsConnection.update,
    updateMany: db.pmsConnection.updateMany,
    findUnique: db.pmsConnection.findUnique,
    post: http.post, put: http.put, get: http.get,
  };
  const state = {
    connection: {
      id: "connection-001", organizationId: "org-001",
      provider: "CHANNEX", status: "ACTIVE",
      webhookSecret: options.initialSecret ?? null,
    },
    httpCalls: 0, unconditionalWrites: 0, conditionalWrites: [] as any[],
    secretReads: 0, payloads: [] as any[],
  };
  const webhooks = new Map<string, any>();
  let reads = 0;
  let releaseReads!: () => void;
  const readBarrier = new Promise<void>((resolve) => { releaseReads = resolve; });
  db.pmsListing.findMany = async (query: any) => {
    const snapshot = {
      id: `listing-${query.where.propertyId}`,
      propertyId: query.where.propertyId,
      metadata: { channexPropertyId: `external-${query.where.propertyId}` },
      connection: { ...state.connection },
    };
    reads += 1;
    if (reads >= (options.simultaneousReads ?? 1)) releaseReads();
    await readBarrier;
    return [snapshot];
  };
  db.pmsListing.update = async (input: any) => input;
  // Keep the old implementation runnable so the regression fails on the
  // observable secret mismatch, rather than simply on a missing mock.
  db.pmsConnection.update = async (input: any) => {
    state.unconditionalWrites += 1;
    state.connection.webhookSecret = input.data.webhookSecret;
    return { ...state.connection };
  };
  db.pmsConnection.updateMany = async (input: any) => {
    state.conditionalWrites.push(input);
    assert.equal(input.where.id, state.connection.id);
    assert.equal(input.where.organizationId, state.connection.organizationId);
    assert.equal(input.where.provider, "CHANNEX");
    assert.equal(input.where.status, "ACTIVE");
    assert.equal(input.where.webhookSecret, options.initialSecret ?? null);
    if (options.updateError) throw new Error("synthetic persistence failure");
    if (options.concurrentSecret) state.connection.webhookSecret = options.concurrentSecret;
    if (options.unexpectedCount !== undefined) return { count: options.unexpectedCount };
    if (state.connection.webhookSecret !== input.where.webhookSecret) return { count: 0 };
    state.connection.webhookSecret = input.data.webhookSecret;
    return { count: 1 };
  };
  db.pmsConnection.findUnique = async (query: any) => {
    state.secretReads += 1;
    assert.equal(query.where.id, state.connection.id);
    return "refreshedConnection" in options
      ? options.refreshedConnection
      : { ...state.connection };
  };
  http.post = async (_url: string, payload: any) => {
    state.httpCalls += 1;
    state.payloads.push(payload.webhook);
    const id = `webhook-${payload.webhook.property_id}`;
    webhooks.set(id, payload.webhook);
    return { data: { data: { id } } };
  };
  http.put = async () => { throw new Error("unexpected PUT for a new property"); };
  http.get = async (url: string) => {
    state.httpCalls += 1;
    const id = decodeURIComponent(url.split("/").pop()!);
    return { data: { data: { id, attributes: webhooks.get(id) } } };
  };
  try { await run(state); }
  finally {
    db.pmsListing.findMany = originals.findMany;
    db.pmsListing.update = originals.updateListing;
    db.pmsConnection.update = originals.updateConnection;
    db.pmsConnection.updateMany = originals.updateMany;
    db.pmsConnection.findUnique = originals.findUnique;
    http.post = originals.post; http.put = originals.put; http.get = originals.get;
  }
}

test("simultaneous new properties share the persisted secret without overwriting one another", async () => {
  await withSecretInitializationMocks({ simultaneousReads: 2 }, async (state) => {
    const results = await Promise.all(["one", "two"].map((propertyId) =>
      configureChannexBookingWebhookForConnectionCenter({
        organizationId: "org-001", propertyId, env: liveEnv,
      })
    ));
    assert.equal(state.payloads.length, 2);
    const secrets = state.payloads.map((payload) => payload.headers["x-pin-go-webhook-secret"]);
    assert.equal(new Set(secrets).size, 1, "one connection must have one shared secret");
    assert.equal(secrets.every((value) => value === state.connection.webhookSecret), true);
    assert.equal(results.filter((result) => result.secretCreated).length, 1);
    assert.equal(results.every((result) => result.verified), true);
    assert.equal(state.unconditionalWrites, 0);
    assert.equal(state.conditionalWrites.length, 2);
    assert.equal(state.secretReads, 1);
  });
});

test("a pre-existing shared secret is never changed or initialized again", async () => {
  await withSecretInitializationMocks({ initialSecret: "preexisting-test-secret" }, async (state) => {
    const result = await registerLive();
    assert.equal(result.secretCreated, false);
    assert.equal(state.unconditionalWrites, 0);
    assert.equal(state.conditionalWrites.length, 0);
    assert.equal(state.secretReads, 0);
    assert.equal(state.payloads[0].headers["x-pin-go-webhook-secret"], "preexisting-test-secret");
  });
});

test("failure to persist the initial secret stops before any HTTP operation", async () => {
  await withSecretInitializationMocks({ updateError: true }, async (state) => {
    await assert.rejects(registerLive(), /synthetic persistence failure/);
    assert.equal(state.httpCalls, 0);
  });
});

test("a competing initializer's stored secret is reused and not reported as newly created", async () => {
  await withSecretInitializationMocks({ concurrentSecret: "other-initializer-secret" }, async (state) => {
    const result = await registerLive();
    assert.equal(result.secretCreated, false);
    assert.equal(state.payloads[0].headers["x-pin-go-webhook-secret"], "other-initializer-secret");
    assert.equal(state.unconditionalWrites, 0);
  });
});

for (const [name, refreshedConnection] of [
  ["deleted connection", null],
  ["missing persisted secret", { organizationId: "org-001", provider: "CHANNEX", status: "ACTIVE", webhookSecret: null }],
  ["different tenant", { organizationId: "other-org", provider: "CHANNEX", status: "ACTIVE", webhookSecret: "test-secret" }],
  ["inactive connection", { organizationId: "org-001", provider: "CHANNEX", status: "INACTIVE", webhookSecret: "test-secret" }],
  ["different provider", { organizationId: "org-001", provider: "GENERIC", status: "ACTIVE", webhookSecret: "test-secret" }],
] as const) {
  test(`secret initialization fails closed after a lost write: ${name}`, async () => {
    await withSecretInitializationMocks({ unexpectedCount: 0, refreshedConnection }, async (state) => {
      await assert.rejects(registerLive(), /CHANNEX_WEBHOOK_SECRET_PERSISTENCE_CONFLICT/);
      assert.equal(state.httpCalls, 0);
    });
  });
}

test("an impossible secret update cardinality stops before HTTP", async () => {
  await withSecretInitializationMocks({ unexpectedCount: 2 }, async (state) => {
    await assert.rejects(registerLive(), /CHANNEX_WEBHOOK_SECRET_PERSISTENCE_CONFLICT/);
    assert.equal(state.httpCalls, 0);
  });
});
