import assert from "node:assert/strict";
import test from "node:test";
import { runChannexDemoWebhookCanary } from "./run-channex-demo-webhook-canary";

const VALID_ENV: NodeJS.ProcessEnv = {
  CHANNEX_DEMO_WEBHOOK_CANARY_CONFIRMATION:
    "RUN_CHANNEX_DEMO_WEBHOOK_CANARY",
  CHANNEX_API_BASE_URL: "https://staging.channex.io",
  CHANNEX_API_KEY: "channex-secret-key",
  CHANNEX_DEMO_WEBHOOK_CANARY_CALLBACK_URL:
    "https://api.pin-ngo.com/webhooks/channex",
};

const channexPropertyId = "1d699e11-593c-4a3d-b66a-28741759e82f";
const callbackUrl = "https://api.pin-ngo.com/webhooks/channex";

function webhookResponse(webhookId = "webhook-001") {
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

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function parseJsonLog(entries: unknown[]) {
  assert.equal(entries.length, 1);
  assert.equal(typeof entries[0], "string");
  return JSON.parse(entries[0] as string) as Record<string, any>;
}

test("blocks before database or network work without explicit confirmation", async () => {
  let findManyCalled = false;
  let fetchCalled = false;
  let disconnectCalled = false;
  const errors: unknown[] = [];

  const exitCode = await runChannexDemoWebhookCanary(
    {
      ...VALID_ENV,
      CHANNEX_DEMO_WEBHOOK_CANARY_CONFIRMATION: "",
    },
    {
      prisma: {
        pmsListing: {
          findMany: async () => {
            findManyCalled = true;
            return [];
          },
        },
      },
      fetch: (async () => {
        fetchCalled = true;
        return jsonResponse({});
      }) as any,
      disconnect: async () => {
        disconnectCalled = true;
      },
      log: () => undefined,
      logError: (value) => errors.push(value),
    }
  );

  assert.equal(exitCode, 1);
  assert.equal(findManyCalled, false);
  assert.equal(fetchCalled, false);
  assert.equal(disconnectCalled, true);

  const output = parseJsonLog(errors);
  assert.equal(output.status, "FAILED_SAFE");
  assert.equal(
    output.errorCode,
    "CHANNEX_DEMO_WEBHOOK_CANARY_CONFIRMATION_REQUIRED"
  );
  assert.equal(output.workersActivated, false);
  assert.equal(output.appChannexTouched, false);
});

test("executes the demo-property webhook canary and restores local state", async () => {
  const originalMetadata = { channexPropertyId };
  const connectionUpdates: unknown[] = [];
  const listingUpdates: unknown[] = [];
  const eventDeletes: unknown[] = [];
  const fetchCalls: Array<{ url: string; method: string }> = [];
  const logs: unknown[] = [];
  const errors: unknown[] = [];
  const startedAt = new Date("2026-08-24T00:00:00.000Z");

  const prisma = {
    pmsListing: {
      findMany: async () => [
        {
          id: "listing-demo",
          propertyId: "property-demo",
          name: "Pin&Go Demo Property",
          metadata: originalMetadata,
          connection: {
            id: "connection-001",
            webhookSecret: null,
          },
        },
      ],
      update: async (input: unknown) => {
        listingUpdates.push(input);
        return input;
      },
    },
    pmsConnection: {
      update: async (input: unknown) => {
        connectionUpdates.push(input);
        return input;
      },
    },
    reservation: {
      count: async () => 7,
    },
    webhookEventIngest: {
      findUnique: async () => ({
        id: "event-001",
        connectionId: "connection-001",
        provider: "CHANNEX",
        eventType: "booking",
        status: "PENDING",
        attempts: 0,
        createdAt: startedAt,
        payloadRaw: { property_id: channexPropertyId },
      }),
      findMany: async () => [],
      deleteMany: async (input: unknown) => {
        eventDeletes.push(input);
        return { count: 1 };
      },
    },
  };

  const fetchImpl = (async (url: string, init?: RequestInit) => {
    fetchCalls.push({ url, method: String(init?.method ?? "GET") });

    if (url.endsWith("/api/v1/webhooks") && init?.method === "POST") {
      return jsonResponse(webhookResponse("webhook-001"), 201);
    }

    if (url.endsWith("/api/v1/webhooks/webhook-001") && init?.method === "GET") {
      return jsonResponse(webhookResponse("webhook-001"));
    }

    if (url.endsWith("/api/v1/webhooks/test") && init?.method === "POST") {
      return jsonResponse({ ok: true, eventId: "event-001" });
    }

    if (url.endsWith("/api/v1/webhooks/webhook-001") && init?.method === "DELETE") {
      return jsonResponse({ ok: true });
    }

    throw new Error(`unexpected fetch ${init?.method ?? "GET"} ${url}`);
  }) as any;

  const exitCode = await runChannexDemoWebhookCanary(VALID_ENV, {
    prisma,
    fetch: fetchImpl,
    now: () => startedAt,
    generateSecret: () => "temporary-secret",
    sleep: async () => undefined,
    disconnect: async () => undefined,
    log: (value) => logs.push(value),
    logError: (value) => errors.push(value),
  });

  assert.equal(exitCode, 0);
  assert.equal(errors.length, 0);

  const output = parseJsonLog(logs);
  assert.equal(output.status, "PASS");
  assert.equal(output.property.listingName, "Pin&Go Demo Property");
  assert.equal(output.remoteWebhookVerified, true);
  assert.equal(output.syntheticEventStoredAsPending, true);
  assert.equal(output.syntheticEventDeleted, true);
  assert.equal(output.reservationDelta, 0);
  assert.equal(output.workersActivated, false);
  assert.equal(output.appChannexTouched, false);

  assert.deepEqual(fetchCalls, [
    {
      url: "https://staging.channex.io/api/v1/webhooks",
      method: "POST",
    },
    {
      url: "https://staging.channex.io/api/v1/webhooks/webhook-001",
      method: "GET",
    },
    {
      url: "https://staging.channex.io/api/v1/webhooks/test",
      method: "POST",
    },
    {
      url: "https://staging.channex.io/api/v1/webhooks/webhook-001",
      method: "DELETE",
    },
  ]);

  assert.equal(connectionUpdates.length, 2);
  assert.deepEqual((connectionUpdates[0] as any).data, {
    webhookSecret: "temporary-secret",
  });
  assert.deepEqual((connectionUpdates[1] as any).data, {
    webhookSecret: null,
  });

  assert.equal(listingUpdates.length, 2);
  assert.equal(
    (listingUpdates[0] as any).data.metadata.channexBookingWebhookId,
    "webhook-001"
  );
  assert.equal(
    (listingUpdates[0] as any).data.metadata.channexBookingWebhookVerified,
    true
  );
  assert.deepEqual((listingUpdates[1] as any).data.metadata, originalMetadata);
  assert.equal(eventDeletes.length, 1);

  const serialized = JSON.stringify({ output, connectionUpdates, listingUpdates });
  assert.equal(serialized.includes("channex-secret-key"), false);
  assert.equal(serialized.includes("temporary-secret"), false);
});

test("restores state when the Channex test callback does not produce an event", async () => {
  const originalMetadata = { channexPropertyId };
  const connectionUpdates: unknown[] = [];
  const listingUpdates: unknown[] = [];
  const errors: unknown[] = [];

  const prisma = {
    pmsListing: {
      findMany: async () => [
        {
          id: "listing-demo",
          propertyId: "property-demo",
          name: "Pin&Go Demo Property",
          metadata: originalMetadata,
          connection: {
            id: "connection-001",
            webhookSecret: null,
          },
        },
      ],
      update: async (input: unknown) => {
        listingUpdates.push(input);
        return input;
      },
    },
    pmsConnection: {
      update: async (input: unknown) => {
        connectionUpdates.push(input);
        return input;
      },
    },
    reservation: {
      count: async () => 7,
    },
    webhookEventIngest: {
      findUnique: async () => null,
      findMany: async () => [],
      deleteMany: async () => ({ count: 0 }),
    },
  };

  const fetchImpl = (async (url: string, init?: RequestInit) => {
    if (url.endsWith("/api/v1/webhooks") && init?.method === "POST") {
      return jsonResponse(webhookResponse("webhook-001"), 201);
    }

    if (url.endsWith("/api/v1/webhooks/webhook-001") && init?.method === "GET") {
      return jsonResponse(webhookResponse("webhook-001"));
    }

    if (url.endsWith("/api/v1/webhooks/test") && init?.method === "POST") {
      return jsonResponse({ ok: true });
    }

    if (url.endsWith("/api/v1/webhooks/webhook-001") && init?.method === "DELETE") {
      return jsonResponse({ ok: true });
    }

    throw new Error(`unexpected fetch ${init?.method ?? "GET"} ${url}`);
  }) as any;

  const exitCode = await runChannexDemoWebhookCanary(VALID_ENV, {
    prisma,
    fetch: fetchImpl,
    now: () => new Date("2026-08-24T00:00:00.000Z"),
    generateSecret: () => "temporary-secret",
    sleep: async () => undefined,
    disconnect: async () => undefined,
    log: () => undefined,
    logError: (value) => errors.push(value),
  });

  assert.equal(exitCode, 1);

  const output = parseJsonLog(errors);
  assert.equal(output.status, "FAILED_SAFE");
  assert.equal(
    output.errorCode,
    "CHANNEX_DEMO_WEBHOOK_CANARY_SYNTHETIC_EVENT_NOT_FOUND"
  );
  assert.equal(output.workersActivated, false);
  assert.equal(output.appChannexTouched, false);

  assert.equal(connectionUpdates.length, 2);
  assert.deepEqual((connectionUpdates[1] as any).data, {
    webhookSecret: null,
  });
  assert.equal(listingUpdates.length, 2);
  assert.deepEqual((listingUpdates[1] as any).data.metadata, originalMetadata);
});
