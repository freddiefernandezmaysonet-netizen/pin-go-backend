import assert from "node:assert/strict";
import test from "node:test";
import { PmsProvider } from "@prisma/client";
import {
  ingestPmsWebhook,
  pmsWebhookRouter,
} from "./webhook.routes";

function getRouteHandler(path: string) {
  const layer = (pmsWebhookRouter as any).stack.find(
    (item: any) => item.route?.path === path
  );

  assert.ok(layer, `Route ${path} not found`);
  const handler = layer.route.stack[0]?.handle;
  assert.equal(typeof handler, "function");
  return handler as (req: any, res: any) => Promise<unknown>;
}

test("legacy generic PMS webhook route rejects Channex before database access", async () => {
  const handler = getRouteHandler("/pms/:provider/:connectionId");
  let statusCode = 200;
  let responseBody: unknown = null;

  const res = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(body: unknown) {
      responseBody = body;
      return this;
    },
  };

  await handler(
    {
      params: {
        provider: "channex",
        connectionId: "known-or-guessed-connection-id",
      },
      headers: {},
      body: {
        event: "booking",
        property_id: "property-001",
      },
    },
    res
  );

  assert.equal(statusCode, 410);
  assert.deepEqual(responseBody, {
    ok: false,
    error: "CHANNEX_LEGACY_WEBHOOK_ROUTE_DISABLED",
  });
});

test("Channex returns 200 immediately after durable event persistence", async () => {
  const operations: string[] = [];

  const result = await ingestPmsWebhook(
    {
      providerEnum: PmsProvider.CHANNEX,
      connectionId: "connection-001",
      headers: {},
      body: {
        event: "booking",
        property_id: "property-001",
        booking_revision_id: "revision-001",
      },
      parsed: {
        eventType: "booking",
        bookingRevision: {
          propertyId: "property-001",
          revisionId: "revision-001",
        },
      },
    },
    {
      findConnection: async () => ({
        id: "connection-001",
        provider: PmsProvider.CHANNEX,
        webhookSecret: null,
      }),
      createEvent: async (data) => {
        operations.push("persist");
        assert.deepEqual(data, {
          connectionId: "connection-001",
          provider: PmsProvider.CHANNEX,
          eventType: "booking",
          externalEventId: "revision-001",
          payloadRaw: {
            event: "booking",
            property_id: "property-001",
            booking_revision_id: "revision-001",
          },
          status: "PENDING",
        });
        return { id: "event-001" };
      },
      enqueueEvent: async () => {
        operations.push("legacy-handoff");
        throw new Error("Channex must not execute legacy handoff");
      },
    }
  );

  assert.deepEqual(operations, ["persist"]);
  assert.deepEqual(result, {
    status: 200,
    body: { ok: true, eventId: "event-001" },
  });
});

test("Channex does not report success when durable persistence fails", async () => {
  const result = await ingestPmsWebhook(
    {
      providerEnum: PmsProvider.CHANNEX,
      connectionId: "connection-001",
      headers: {},
      body: {
        event: "booking",
        property_id: "property-001",
      },
      parsed: {
        eventType: "booking",
        bookingRevision: { propertyId: "property-001" },
      },
    },
    {
      findConnection: async () => ({
        id: "connection-001",
        provider: PmsProvider.CHANNEX,
        webhookSecret: null,
      }),
      createEvent: async () => {
        throw new Error("database unavailable");
      },
      enqueueEvent: async () => {
        throw new Error("must not enqueue");
      },
    }
  );

  assert.equal(result.status, 500);
  assert.deepEqual(result.body, {
    ok: false,
    error: "STORE_EVENT_FAILED",
    detail: "database unavailable",
  });
});
