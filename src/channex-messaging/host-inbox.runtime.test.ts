import assert from "node:assert/strict";
import test from "node:test";
import { Prisma } from "@prisma/client";
import { buildHostInboxRuntime } from "./host-inbox.runtime.js";

const env = { CHANNEX_HOST_INBOX_ENABLED: "true", OTA_CONNECTION_CENTER_ENABLED: "true",
  OTA_CONNECTION_PROVIDER_API_ORIGIN: "https://staging.channex.io", OTA_CONNECTION_IFRAME_BASE_URL: "https://staging.channex.io/channels",
  OTA_CONNECTION_API_KEY: "test-key", OTA_CONNECTION_DEFAULT_CURRENCY: "USD", OTA_CONNECTION_AIRBNB_FILTER: "Airbnb", OTA_CONNECTION_BOOKING_FILTER: "BookingCom", OTA_CONNECTION_VRBO_FILTER: "Vrbo" };
const property = "11111111-1111-4111-8111-111111111111", thread = "22222222-2222-4222-8222-222222222222";
function setup() {
  let mappingQuery: any, postCount = 0;
  const receipts = new Map<string, any>();
  const prisma = {
    distributionProperty: {
      async findFirst(query: any) { mappingQuery = query; return { externalPropertyId: property }; },
      async findMany(query: any) { mappingQuery = query; return [{ property: { id: "local", name: "House" } }]; },
    },
    channexHostMessageSend: {
      async create({ data }: any) {
        const key = `${data.organizationId}:${data.requestKey}`;
        if (receipts.has(key)) throw new Prisma.PrismaClientKnownRequestError("unique", { code: "P2002", clientVersion: "6.19.3" });
        const row = { ...data, status: "PENDING", response: null }; receipts.set(key, row); return row;
      },
      async findUnique({ where }: any) { const k = where.organizationId_requestKey; return receipts.get(`${k.organizationId}:${k.requestKey}`); },
      async update({ where, data }: any) { const k = where.organizationId_requestKey; Object.assign(receipts.get(`${k.organizationId}:${k.requestKey}`), data); },
      async updateMany({ where, data }: any) { Object.assign(receipts.get(`${where.organizationId}:${where.requestKey}`), data); },
    },
  };
  const fetchImpl: typeof fetch = async (_url, init) => {
    if (init?.method === "POST") {
      postCount++;
      return new Response(JSON.stringify({ data: { type: "message", id: property, attributes: { message: "Hola", sender: "property", attachments: [], inserted_at: "2026-10-03T01:00:00" }, relationships: { message_thread: { data: { type: "message_thread", id: thread } } } } }));
    }
    return new Response(JSON.stringify({ data: { id: thread, type: "message_thread", attributes: { title: "Guest", provider: "Airbnb", is_closed: false, message_count: 0, updated_at: "2026-10-03T01:00:00", last_message: null }, relationships: { property: { data: { id: property, type: "property" } } } } }));
  };
  return { prisma, fetchImpl, receipts, query: () => mappingQuery, postCount: () => postCount };
}
test("runtime is off unless both inbox and canonical Connection Center config are enabled", () => {
  const f = setup();
  for (const values of [{ ...env, CHANNEX_HOST_INBOX_ENABLED: "false" }, { ...env, OTA_CONNECTION_CENTER_ENABLED: "false" }, { ...env, NODE_ENV: "production" }]) assert.equal(buildHostInboxRuntime({ prisma: f.prisma as any, env: values }), null);
});
test("runtime checks canonical tenant/group readiness and exposes local property options", async () => {
  const f = setup(); const runtime = buildHostInboxRuntime({ prisma: f.prisma as any, env, fetchImpl: f.fetchImpl })!;
  assert.deepEqual(await runtime.properties("org-a"), { items: [{ id: "local", name: "House", pinAIDraftsEnabled: false }] });
  assert.equal(f.query().where.organizationId, "org-a"); assert.equal(f.query().where.property.organizationId, "org-a"); assert.equal(f.query().where.group.organizationId, "org-a");
});
test("property capability exposes Pin AI only for the exact configured scope", async () => {
  const f = setup(); const runtime = buildHostInboxRuntime({ prisma: f.prisma as any, fetchImpl: f.fetchImpl,
    env: { ...env, PIN_AI_CHANNEX_DRAFT_ENABLED: "true", PIN_AI_CHANNEX_DRAFT_ORGANIZATION_IDS: "org-a", PIN_AI_CHANNEX_DRAFT_PROPERTY_IDS: "local" } })!;
  assert.equal((await runtime.properties("org-a")).items[0]?.pinAIDraftsEnabled, true);
  assert.equal((await runtime.properties("org-b")).items[0]?.pinAIDraftsEnabled, false);
});
test("persistent unique receipt handles concurrent sends and service restarts", async () => {
  const f = setup(), args = { prisma: f.prisma as any, env, fetchImpl: f.fetchImpl };
  const runtime = buildHostInboxRuntime(args)!;
  const reply = { organizationId: "org-a", propertyId: "local", threadId: thread, requestedBy: "host-a", text: "Hola", requestKey: "request-123" };
  await Promise.allSettled([runtime.reply(reply), runtime.reply(reply)]);
  assert.equal(f.postCount(), 1);
  assert.equal(f.query().where.propertyId, "local"); assert.equal(f.query().where.group.provisioningStatus, "READY");
  assert.equal((await buildHostInboxRuntime(args)!.reply(reply)).replayed, true); assert.equal(f.postCount(), 1);
  assert.equal(f.receipts.get("org-a:request-123")?.requestedBy, "host-a");
});
