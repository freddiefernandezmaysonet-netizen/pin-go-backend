import assert from "node:assert/strict";
import test from "node:test";
import { runChannexDemoWebhookCanary } from "./run-channex-demo-webhook-canary";

const env: NodeJS.ProcessEnv = {
  CHANNEX_DEMO_WEBHOOK_CANARY_CONFIRMATION:
    "RUN_CHANNEX_DEMO_WEBHOOK_CANARY",
  CHANNEX_API_BASE_URL: "https://staging.channex.io",
  CHANNEX_API_KEY: "secret-key",
  CHANNEX_DEMO_WEBHOOK_CANARY_CALLBACK_URL:
    "https://api.pin-ngo.com/webhooks/channex",
};

const channexPropertyId = "1d699e11-593c-4a3d-b66a-28741759e82f";

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function webhook() {
  return {
    data: {
      id: "webhook-001",
      type: "webhook",
      attributes: {
        callback_url: "https://api.pin-ngo.com/webhooks/channex",
        event_mask: "booking",
        is_active: true,
        send_data: false,
      },
      relationships: {
        property: {
          data: { id: channexPropertyId, type: "property" },
        },
      },
    },
  };
}

test("never reports PASS when temporary remote webhook cleanup fails", async () => {
  const errors: unknown[] = [];
  const originalMetadata = { channexPropertyId };
  const connectionUpdates: any[] = [];
  const listingUpdates: any[] = [];

  const prisma = {
    pmsListing: {
      findMany: async () => [
        {
          id: "listing-demo",
          propertyId: "property-demo",
          name: "Pin&Go Demo Property",
          metadata: originalMetadata,
          connection: { id: "connection-001", webhookSecret: null },
        },
      ],
      update: async (input: any) => {
        listingUpdates.push(input);
        return input;
      },
    },
    pmsConnection: {
      update: async (input: any) => {
        connectionUpdates.push(input);
        return input;
      },
    },
    reservation: { count: async () => 7 },
  };

  const fetchImpl = (async (url: string, init?: RequestInit) => {
    if (url.endsWith("/api/v1/webhooks") && init?.method === "POST") {
      return response(webhook(), 201);
    }
    if (
      url.endsWith("/api/v1/webhooks/webhook-001") &&
      init?.method === "GET"
    ) {
      return response(webhook());
    }
    if (
      url.endsWith("/api/v1/webhooks/webhook-001") &&
      init?.method === "DELETE"
    ) {
      return response({ error: "temporary failure" }, 503);
    }
    throw new Error(`unexpected fetch ${init?.method ?? "GET"} ${url}`);
  }) as any;

  const exitCode = await runChannexDemoWebhookCanary(env, {
    prisma,
    fetch: fetchImpl,
    generateSecret: () => "temporary-secret",
    disconnect: async () => undefined,
    log: () => {
      throw new Error("PASS must not be logged when cleanup fails");
    },
    logError: (value) => errors.push(value),
  });

  assert.equal(exitCode, 1);
  assert.equal(errors.length, 1);
  const output = JSON.parse(errors[0] as string);
  assert.equal(output.status, "FAILED_SAFE");
  assert.match(output.errorCode, /CHANNEX_DEMO_WEBHOOK_CANARY_CLEANUP_FAILED/);

  assert.equal(listingUpdates.length >= 2, true);
  assert.deepEqual(listingUpdates.at(-1).data.metadata, originalMetadata);
  assert.equal(connectionUpdates.length >= 2, true);
  assert.equal(connectionUpdates.at(-1).data.webhookSecret, null);
});
