import assert from "node:assert/strict";
import test from "node:test";
import axios from "axios";
import { prisma } from "../lib/prisma";
import {
  assertVerifiedChannexWebhook,
  buildChannexBookingWebhookPayload,
  configureChannexBookingWebhookForStaging,
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
