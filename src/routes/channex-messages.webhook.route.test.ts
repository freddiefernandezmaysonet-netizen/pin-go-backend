import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import type { AddressInfo } from "node:net";
import { buildChannexMessagesWebhookRouter } from "./channex-messages.webhook.route.js";
import { AI_WEBHOOK_HEADER, AI_WEBHOOK_PATH } from "../channex-messaging/pin-ai-auto.policy.js";

test("webhook rejects missing/incorrect auth and acknowledges only persisted ingestion", async () => {
  let calls = 0, fail = false;
  const app = express(); app.use(express.json());
  app.use(buildChannexMessagesWebhookRouter({ enabled: true, secret: "x".repeat(32), receive: async () => { calls++; if (fail) throw new Error("db offline"); return { ignored: false }; } }));
  const server = app.listen(0, "127.0.0.1"); await new Promise<void>(resolve => server.once("listening", resolve));
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}${AI_WEBHOOK_PATH}`;
    for (const secret of ["", "wrong"]) {
      assert.equal((await fetch(url, { method: "POST", headers: { [AI_WEBHOOK_HEADER]: secret } })).status, 401);
    }
    assert.equal(calls, 0);
    assert.equal((await fetch(url, { method: "POST", headers: { [AI_WEBHOOK_HEADER]: "x".repeat(32) } })).status, 202);
    fail = true;
    const failure = await fetch(url, { method: "POST", headers: { [AI_WEBHOOK_HEADER]: "x".repeat(32) } });
    assert.equal(failure.status, 503); assert.deepEqual(await failure.json(), { ok: false, error: "PIN_AI_INGEST_UNAVAILABLE" });
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
