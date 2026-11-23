import assert from "node:assert/strict";
import test from "node:test";
import { createHmac } from "node:crypto";
import { once } from "node:events";
import express from "express";
import { buildMessageDeliveryWebhookRouter } from "./message-delivery.webhooks.routes";

const account = "AC" + "1".repeat(32);
const secret = Buffer.from("synthetic-receipt-signature-key");
const token = "synthetic-twilio-token";

test("real webhook handlers authenticate before durable capture and preserve default-off behavior", async t => {
  const rows = new Map<string, any>();
  let databaseFails = false;
  let legacyReads = 0;
  const db: any = {
    messageDeliveryReceipt: { upsert: async ({where, create}: any) => {
      if (databaseFails) throw Error("SYNTHETIC_DATABASE_UNAVAILABLE");
      if (!rows.has(where.id)) rows.set(where.id, create);
      return rows.get(where.id);
    } },
    messageLog: { findFirst: async () => { legacyReads++; return null; } },
  };
  const env: NodeJS.ProcessEnv = { MESSAGE_DELIVERY_WEBHOOKS_ENABLED: "1",
    MESSAGE_DELIVERY_RECEIPT_INBOX_MODE: "CAPTURE", MESSAGE_DELIVERY_RESEND_ACCOUNT_KEY: "synthetic-platform",
    RESEND_WEBHOOK_SECRET: "whsec_" + secret.toString("base64"),
    TWILIO_ACCOUNT_SID: account, TWILIO_AUTH_TOKEN: token, PUBLIC_API_BASE_URL: "https://api.example.invalid" };
  const app = express();
  app.use(express.json({ verify: (req: any, _res, body) => { req.rawBody = body; } }));
  app.use(express.urlencoded({ extended: false }));
  app.use(buildMessageDeliveryWebhookRouter(db, env));
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address() as { port: number };
  const base = `http://127.0.0.1:${address.port}`;
  const resend = async (id: string, valid = true) => {
    const body = JSON.stringify({ type: "email.delivered", created_at: "2026-11-22T16:00:00Z",
      data: { email_id: "synthetic-email", to: ["private@example.invalid"], subject: "Do not retain raw body" } });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac("sha256", secret).update(`${id}.${timestamp}.${body}`).digest("base64");
    return fetch(`${base}/webhooks/delivery/resend`, { method: "POST", body, headers: {
      "content-type": "application/json", "svix-id": id, "svix-timestamp": timestamp,
      "svix-signature": "v1," + (valid ? signature : "invalid"),
    } });
  };
  const twilio = async (sid: string, valid = true) => {
    const params: Record<string, string> = { AccountSid: sid, MessageSid: "SM" + "2".repeat(32),
      MessageStatus: "delivered", To: "+15005550006" };
    const signed = "https://api.example.invalid/webhooks/delivery/twilio" +
      Object.keys(params).sort().map(key => key + params[key]).join("");
    const signature = createHmac("sha1", token).update(signed).digest("base64");
    return fetch(`${base}/webhooks/delivery/twilio`, { method: "POST", body: new URLSearchParams(params),
      headers: { "x-twilio-signature": valid ? signature : "invalid" } });
  };
  assert.equal((await resend("bad", false)).status, 403);
  assert.equal((await twilio(account, false)).status, 403);
  assert.equal(rows.size, 0); assert.equal(legacyReads, 0);
  const first = await resend("event-1");
  assert.equal(first.status, 200); assert.equal((await first.json()).matched, false);
  assert.equal((await resend("event-1")).status, 200); assert.equal(rows.size, 1);
  assert.equal((await twilio(account)).status, 204);
  assert.equal((await twilio(account)).status, 204); assert.equal(rows.size, 2);
  assert.equal((await twilio("AC" + "3".repeat(32))).status, 500); assert.equal(rows.size, 2);
  const persisted = JSON.stringify([...rows.values()]);
  assert.doesNotMatch(persisted, /private@example|Do not retain|15005550006|synthetic-twilio-token/);
  databaseFails = true;
  assert.equal((await resend("event-db-failure")).status, 500);
  databaseFails = false;
  env.MESSAGE_DELIVERY_RECEIPT_INBOX_MODE = "OFF";
  assert.equal((await resend("legacy-only")).status, 200); assert.equal(rows.size, 2);
  env.MESSAGE_DELIVERY_RECEIPT_INBOX_MODE = "INVALID";
  assert.equal((await resend("invalid-mode")).status, 500); assert.equal(rows.size, 2);
  env.MESSAGE_DELIVERY_RECEIPT_INBOX_MODE = "CAPTURE";
  delete env.MESSAGE_DELIVERY_RESEND_ACCOUNT_KEY;
  assert.equal((await resend("missing-account")).status, 500); assert.equal(rows.size, 2);
});
