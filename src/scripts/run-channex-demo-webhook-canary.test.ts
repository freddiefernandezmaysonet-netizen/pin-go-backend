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

function demoListing() {
  return {
    id: "listing-demo",
    propertyId: "property-demo",
    name: "Pin&Go Demo Property",
    metadata: { channexPropertyId },
    connection: {
      id: "connection-001",
      webhookSecret: null,
    },
  };
}

function prismaMock(args: {
  listings?: any[];
  reservationCounts?: number[];
  connectionUpdates?: unknown[];
  listingUpdates?: unknown[];
}) {
  const counts = [...(args.reservationCounts ?? [7, 7])];
  return {
    pmsListing: {
      findMany: async () => args.listings ?? [demoListing()],
      update: async (input: unknown) => {
        args.listingUpdates?.push(input);
        return input;
      },
    },
    pmsConnection: {
      update: async (input: unknown) => {
        args.connectionUpdates?.push(input);
        return input;
      },
    },
    reservation: {
      count: async () => counts.shift() ?? 7,
    },
  };
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

test("blocks app.channex.io before database or network work", async () => {
  let findManyCalled = false;
  let fetchCalled = false;
  const errors: unknown[] = [];

  const exitCode = await runChannexDemoWebhookCanary(
    {
      ...VALID_ENV,
      CHANNEX_API_BASE_URL: "https://app.channex.io",
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
      disconnect: async () => undefined,
      log: () => undefined,
      logError: (value) => errors.push(value),
    }
  );

  assert.equal(exitCode, 1);
  assert.equal(findManyCalled, false);
  assert.equal(fetchCalled, false);
  assert.equal(parseJsonLog(errors).status, "FAILED_SAFE");
});

test("requires exactly one active Pin&Go Demo Property listing", async () => {
  const errors: unknown[] = [];
  let fetchCalled = false;

  const exitCode = await runChannexDemoWebhookCanary(VALID_ENV, {
    prisma: prismaMock({ listings: [] }),
    fetch: (async () => {
      fetchCalled = true;
      return jsonResponse({});
    }) as any,
    disconnect: async () => undefined,
    log: () => undefined,
    logError: (value) => errors.push(value),
  });

  assert.equal(exitCode, 1);
  assert.equal(fetchCalled, false);
  assert.equal(
    parseJsonLog(errors).errorCode,
    "CHANNEX_DEMO_WEBHOOK_CANARY_LISTING_NOT_FOUND"
  );
});

test("registers and verifies only the demo webhook then restores local and remote state", async () => {
  const originalMetadata = { channexPropertyId };
  const connectionUpdates: unknown[] = [];
  const listingUpdates: unknown[] = [];
  const fetchCalls: Array<{ url: string; method: string; body?: string }> = [];
  const logs: unknown[] = [];
  const errors: unknown[] = [];

  const fetchImpl = (async (url: string, init?: RequestInit) => {
    fetchCalls.push({
      url,
      method: String(init?.method ?? "GET"),
      body: typeof init?.body === "string" ? init.body : undefined,
    });

    if (url.endsWith("/api/v1/webhooks") && init?.method === "POST") {
      return jsonResponse(webhookResponse("webhook-001"), 201);
    }

    if (
      url.endsWith("/api/v1/webhooks/webhook-001") &&
      init?.method === "GET"
    ) {
      return jsonResponse(webhookResponse("webhook-001"));
    }

    if (
      url.endsWith("/api/v1/webhooks/webhook-001") &&
      init?.method === "DELETE"
    ) {
      return jsonResponse({ ok: true });
    }

    throw new Error(`unexpected fetch ${init?.method ?? "GET"} ${url}`);
  }) as any;

  const exitCode = await runChannexDemoWebhookCanary(VALID_ENV, {
    prisma: prismaMock({
      listings: [{ ...demoListing(), metadata: originalMetadata }],
      reservationCounts: [7, 7],
      connectionUpdates,
      listingUpdates,
    }),
    fetch: fetchImpl,
    now: () => new Date("2026-08-24T00:00:00.000Z"),
    generateSecret: () => "temporary-secret",
    disconnect: async () => undefined,
    log: (value) => logs.push(value),
    logError: (value) => errors.push(value),
  });

  assert.equal(exitCode, 0);
  assert.equal(errors.length, 0);

  const output = parseJsonLog(logs);
  assert.equal(output.status, "PASS_REMOTE_WEBHOOK_REGISTRATION");
  assert.equal(output.property.listingName, "Pin&Go Demo Property");
  assert.equal(output.remoteWebhookCreated, true);
  assert.equal(output.remoteWebhookVerified, true);
  assert.equal(output.callbackDeliveryAttempted, false);
  assert.equal(output.syntheticEventStoredAsPending, false);
  assert.equal(output.reservationDelta, 0);
  assert.equal(output.workersActivated, false);
  assert.equal(output.appChannexTouched, false);

  assert.deepEqual(
    fetchCalls.map(({ url, method }) => ({ url, method })),
    [
      {
        url: "https://staging.channex.io/api/v1/webhooks",
        method: "POST",
      },
      {
        url: "https://staging.channex.io/api/v1/webhooks/webhook-001",
        method: "GET",
      },
      {
        url: "https://staging.channex.io/api/v1/webhooks/webhook-001",
        method: "DELETE",
      },
    ]
  );

  const createBody = JSON.parse(fetchCalls[0]!.body!);
  assert.equal(createBody.webhook.property_id, channexPropertyId);
  assert.equal(createBody.webhook.callback_url, callbackUrl);
  assert.equal(createBody.webhook.event_mask, "booking");
  assert.equal(createBody.webhook.send_data, false);
  assert.equal(createBody.webhook.is_active, true);
  assert.equal(
    createBody.webhook.headers["x-pin-go-webhook-secret"],
    "temporary-secret"
  );

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

  const serialized = JSON.stringify({ output, connectionUpdates, listingUpdates });
  assert.equal(serialized.includes("channex-secret-key"), false);
  assert.equal(serialized.includes("temporary-secret"), false);
});

test("restores state when remote verification fails", async () => {
  const originalMetadata = { channexPropertyId };
  const connectionUpdates: unknown[] = [];
  const listingUpdates: unknown[] = [];
  const errors: unknown[] = [];
  const fetchCalls: Array<{ url: string; method: string }> = [];

  const fetchImpl = (async (url: string, init?: RequestInit) => {
    fetchCalls.push({ url, method: String(init?.method ?? "GET") });

    if (url.endsWith("/api/v1/webhooks") && init?.method === "POST") {
      return jsonResponse(webhookResponse("webhook-001"), 201);
    }

    if (
      url.endsWith("/api/v1/webhooks/webhook-001") &&
      init?.method === "GET"
    ) {
      const bad = webhookResponse("webhook-001");
      bad.data.attributes.callback_url =
        "https://wrong.example.com/webhooks/channex";
      return jsonResponse(bad);
    }

    if (
      url.endsWith("/api/v1/webhooks/webhook-001") &&
      init?.method === "DELETE"
    ) {
      return jsonResponse({ ok: true });
    }

    throw new Error(`unexpected fetch ${init?.method ?? "GET"} ${url}`);
  }) as any;

  const exitCode = await runChannexDemoWebhookCanary(VALID_ENV, {
    prisma: prismaMock({
      listings: [{ ...demoListing(), metadata: originalMetadata }],
      connectionUpdates,
      listingUpdates,
    }),
    fetch: fetchImpl,
    generateSecret: () => "temporary-secret",
    disconnect: async () => undefined,
    log: () => undefined,
    logError: (value) => errors.push(value),
  });

  assert.equal(exitCode, 1);
  assert.equal(parseJsonLog(errors).status, "FAILED_SAFE");
  assert.deepEqual(
    fetchCalls.map(({ url, method }) => ({ url, method })),
    [
      {
        url: "https://staging.channex.io/api/v1/webhooks",
        method: "POST",
      },
      {
        url: "https://staging.channex.io/api/v1/webhooks/webhook-001",
        method: "GET",
      },
      {
        url: "https://staging.channex.io/api/v1/webhooks/webhook-001",
        method: "DELETE",
      },
    ]
  );
  assert.equal(connectionUpdates.length, 0);
  assert.equal(listingUpdates.length, 0);
});
