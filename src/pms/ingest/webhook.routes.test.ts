import assert from "node:assert/strict";
import test from "node:test";
import { pmsWebhookRouter } from "./webhook.routes";

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
