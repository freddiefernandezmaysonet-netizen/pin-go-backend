import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PrismaClient } from "@prisma/client";
import { buildHostInboxRuntime } from "./host-inbox.runtime.js";
import { readMobileReplyReceipt } from "./mobile-reply-receipt.js";

// Only an explicitly supplied local disposable database is allowed.
const connection = process.env.INBOX_POSTGRES_TEST_URL;
test("host inbox receipt migration and concurrency in PostgreSQL", { skip: !connection }, async t => {
  const url = new URL(connection!);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname));
  assert.ok(["postgresql:", "postgres:"].includes(url.protocol));
  const schema = `inbox_test_${randomUUID().replaceAll("-", "")}`;
  const admin = new PrismaClient({ datasourceUrl: url.toString() });
  await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
  url.searchParams.set("schema", schema);
  const db = new PrismaClient({ datasourceUrl: url.toString() });
  const db2 = new PrismaClient({ datasourceUrl: url.toString() });
  const env = { NODE_ENV: "test", CHANNEX_HOST_INBOX_ENABLED: "true", OTA_CONNECTION_CENTER_ENABLED: "true",
    OTA_CONNECTION_PROVIDER_API_ORIGIN: "https://staging.channex.io", OTA_CONNECTION_IFRAME_BASE_URL: "https://staging.channex.io/channels",
    OTA_CONNECTION_API_KEY: "synthetic", OTA_CONNECTION_DEFAULT_CURRENCY: "USD", OTA_CONNECTION_AIRBNB_FILTER: "Airbnb", OTA_CONNECTION_BOOKING_FILTER: "BookingCom", OTA_CONNECTION_VRBO_FILTER: "Vrbo" };
  const property = "11111111-1111-4111-8111-111111111111", thread = "22222222-2222-4222-8222-222222222222";
  const reply = { organizationId: "synthetic-org", propertyId: "synthetic-property", threadId: thread, requestedBy: "synthetic-host", requestKey: "concurrent-123", text: "synthetic reply" };
  let posts = 0;
  // Channex and property inventory are synthetic; the receipt delegate is real Prisma/PostgreSQL.
  const runtime = (client: PrismaClient) => buildHostInboxRuntime({ env, prisma: {
    distributionProperty: { findFirst: async () => ({ externalPropertyId: property }) },
    channexHostMessageSend: client.channexHostMessageSend,
  } as unknown as PrismaClient, fetchImpl: async (_url, init) => {
    if (init?.method === "POST") {
      posts++;
      const text = JSON.parse(String(init.body)).message.message as string;
      if (text === "uncertain") throw new Error("synthetic timeout after acceptance");
      await new Promise(resolve => setTimeout(resolve, 30));
      return new Response(JSON.stringify({ data: { id: randomUUID(), type: "message", attributes: { message: text, sender: "property", inserted_at: "2026-10-03T01:00:00", attachments: [] }, relationships: { message_thread: { data: { id: thread, type: "message_thread" } } } } }));
    }
    return new Response(JSON.stringify({ data: { id: thread, type: "message_thread", attributes: { title: "Synthetic Guest", provider: "Airbnb", is_closed: false, message_count: 0, last_message: null, updated_at: "2026-10-03T01:00:00" }, relationships: { property: { data: { id: property, type: "property" } } } } }));
  } })!;
  try {
    const migration = await readFile(new URL("../../prisma/migrations/20261003010000_channex_host_message_send/migration.sql", import.meta.url), "utf8");
    for (const statement of migration.split(";").filter(part => part.trim())) await db.$executeRawUnsafe(statement);
    await t.test("migration creates the receipt table and enforces allowed states", async () => {
      assert.equal(await db.channexHostMessageSend.count(), 0);
      const { text: _text, ...fields } = reply;
      await assert.rejects(db.channexHostMessageSend.create({ data: { ...fields, fingerprint: "a".repeat(64), status: "INVALID" } }), /check constraint/);
      assert.equal(await db.channexHostMessageSend.count(), 0);
    });
    await t.test("12 concurrent requests through two clients cause one provider POST", async () => {
      const a = runtime(db), b = runtime(db2);
      const results = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => (i % 2 ? a : b).reply(reply)));
      assert.ok(results.some(result => result.status === "fulfilled"));
      assert.equal(posts, 1);
      assert.equal(await db.channexHostMessageSend.count(), 1);
      assert.equal((await db.channexHostMessageSend.findFirstOrThrow()).status, "SENT");
    });
    await t.test("a reconstructed runtime replays the persisted receipt and rejects a changed body", async () => {
      await db2.$disconnect();
      const rebuilt = runtime(db2);
      const result = await rebuilt.reply(reply);
      assert.equal(result.replayed, true); assert.equal(posts, 1);
      await assert.rejects(rebuilt.reply({ ...reply, text: "different" }), /REQUEST_KEY_CONFLICT/);
      assert.equal(posts, 1);
    });
    await t.test("mobile receipt recovery uses persisted acceptance and exact actor/tenant/destination scope", async () => {
      const { text: _text, ...scope } = reply;
      const lookup = (input: typeof scope) => db2.channexHostMessageSend.findFirst({ where: input, select: { status: true, response: true } });
      const accepted = await readMobileReplyReceipt(scope, lookup);
      assert.equal(accepted.status, "ACCEPTED");
      for (const change of [
        { organizationId: "other-org" }, { requestedBy: "other-host" },
        { propertyId: "other-property" }, { threadId: "33333333-3333-4333-8333-333333333333" },
        { requestKey: "missing-key-123" },
      ]) assert.equal((await readMobileReplyReceipt({ ...scope, ...change }, lookup)).status, "UNCONFIRMED");
      assert.equal(posts, 1);
      assert.equal(await db.channexHostMessageSend.count(), 1);
    });
    await t.test("uncertain delivery persists and blocks resubmission from another process client", async () => {
      const input = { ...reply, requestKey: "unknown-123", text: "uncertain" };
      await assert.rejects(runtime(db).reply(input), /SEND_OUTCOME_UNKNOWN/);
      await assert.rejects(runtime(db2).reply(input), /SEND_OUTCOME_UNKNOWN/);
      assert.equal(posts, 2);
      assert.equal((await db.channexHostMessageSend.findUniqueOrThrow({ where: { organizationId_requestKey: { organizationId: input.organizationId, requestKey: input.requestKey } } })).status, "UNKNOWN");
    });
    await t.test("a PENDING receipt left by an interrupted process never resends", async () => {
      const { text, ...input } = { ...reply, requestKey: "interrupted-123" };
      const fingerprint = createHash("sha256").update(JSON.stringify([input.propertyId, input.threadId, text, input.requestedBy])).digest("hex");
      await db.channexHostMessageSend.create({ data: { ...input, fingerprint } });
      await assert.rejects(runtime(db2).reply({ ...input, text }), /SEND_OUTCOME_UNKNOWN/);
      assert.equal(posts, 2);
    });
  } finally {
    await Promise.all([db.$disconnect(), db2.$disconnect()]);
    await admin.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.$disconnect();
  }
});
