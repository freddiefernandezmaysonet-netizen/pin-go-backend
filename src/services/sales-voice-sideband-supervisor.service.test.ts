import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { after, test } from "node:test";
import { PrismaClient } from "@prisma/client";
import {
  observeExistingLiveSession, liveSidebandAttachUrl,
  SalesSidebandError, type SidebandSocketFactory,
} from "./sales-voice-sideband-supervisor.service.js";

const databaseUrl = process.env.SALES_SIDEBAND_TEST_DATABASE_URL;
assert.ok(databaseUrl, "CI must provide a disposable database URL");
const url = new URL(databaseUrl);
assert.equal(url.protocol, "postgresql:");
assert.ok(["localhost", "127.0.0.1"].includes(url.hostname));
assert.equal(url.pathname, "/pingo_sales_sideband_test");
assert.equal(process.env.DATABASE_URL, databaseUrl);
const db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
after(async () => db.$disconnect());

function incomingId(n: number) { return "live_test_sideband_" + n; }
async function call(n: number, status = "ACCEPTED") {
  return db.salesVoiceCall.create({
    data: {
      provider: "OPENAI_LIVE_SIP", providerCallId: incomingId(n),
      direction: "INBOUND", status,
      answeredAt: new Date(), startedAt: new Date(),
    },
  });
}
async function reset() {
  await db.salesVoiceCall.deleteMany({ where: { provider: { in: ["OPENAI_LIVE_SIP", "TWILIO"] } } });
}
const err = (code: string) => (e: unknown) =>
  e instanceof SalesSidebandError && e.code === code;

class MockSocket extends EventEmitter {
  sent: unknown[] = [];
  closed = false;
  close() { this.closed = true; }
  deliver(event: unknown) { this.emit("message", Buffer.from(JSON.stringify(event))); }
  drop() { this.emit("close"); }
  started(sessionId: string) {
    this.deliver({ type: "session.started", event_id: "evt_started_1",
      session: { id: sessionId } });
  }
  usage(seconds: number) {
    this.deliver({ type: "session.usage.updated", event_id: "evt_usage_1", usage: { seconds } });
  }
  finished(sessionId: string, seconds: number) {
    this.deliver({ type: "session.closed", event_id: "evt_closed_1",
      reason: "remote_hangup", usage: { seconds }, session: { id: sessionId } });
  }
}
function factory(socket: MockSocket, seen: unknown[]) {
  return ((url: string, options: unknown) => {
    seen.push({ url, options });
    return socket;
  }) as SidebandSocketFactory;
}
async function attach(n: number, socket: MockSocket, seen: unknown[], opts: {
  enabled?: boolean; apiKey?: string;
} = {}) {
  return observeExistingLiveSession({
    db, sessionId: incomingId(n), apiKey: opts.apiKey ?? "sk-test-ephemeral",
    enabled: opts.enabled ?? true, connect: factory(socket, seen),
  });
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test("the sideband endpoint is fixed, TLS-only, and rejects malformed IDs", () => {
  assert.equal(liveSidebandAttachUrl(incomingId(1)),
    "wss://api.openai.com/v1/live/sessions/" + incomingId(1) + "/attach");
  assert.throws(() => liveSidebandAttachUrl("https://evil.example/"), err("INVALID_LIVE_SESSION_ID"));
});

test("disabled and invalid key cannot open any provider socket", async () => {
  await reset(); await call(2);
  const socket = new MockSocket();
  const seen: unknown[] = [];
  await assert.rejects(attach(2,socket,seen,{enabled:false}),err("SUPERVISOR_DISABLED"));
  await assert.rejects(attach(2,socket,seen,{apiKey:"user-key"}),err("API_KEY_REQUIRED"));
  assert.equal(seen.length,0);
});

test("an unverified or completed session cannot be observed", async () => {
  await reset();
  const socket = new MockSocket(), seen: unknown[] = [];
  await assert.rejects(attach(3,socket,seen),err("VERIFIED_ACTIVE_LIVE_CALL_REQUIRED"));
  await call(3,"COMPLETED");
  await assert.rejects(attach(3,socket,seen),err("VERIFIED_ACTIVE_LIVE_CALL_REQUIRED"));
  assert.equal(seen.length,0);
});

test("authenticated sideband requests exact project header and never sends session.start", async () => {
  await reset(); await call(4);
  const socket = new MockSocket(), seen: any[] = [];
  const connection = await attach(4,socket,seen);
  assert.equal(seen.length,1);
  assert.equal(seen[0].url,liveSidebandAttachUrl(incomingId(4)));
  assert.equal(seen[0].options.headers.Authorization,"Bearer sk-test-ephemeral");
  assert.equal(seen[0].options.handshakeTimeout,5000);
  assert.equal(seen[0].options.perMessageDeflate,false);
  assert.deepEqual(socket.sent,[]);
  connection.disconnect();
  assert.equal((await connection.completion).state,"UNCONFIRMED_DISCONNECT");
});

test("usage before sideband identity attestation cannot change call records", async () => {
  await reset(); await call(5);
  const socket = new MockSocket(), seen: unknown[] = [];
  const connected = await attach(5,socket,seen);
  socket.usage(10);
  assert.equal((await connected.completion).state,"AUTHENTICATION_MISMATCH");
  const row = await db.salesVoiceCall.findUniqueOrThrow({where:{providerCallId:incomingId(5)}});
  assert.equal(row.lastUsageSeconds,null);
  assert.equal(row.finalizedAt,null);
});

test("wrong session.started ID cannot authorize usage, and capacity stays held", async () => {
  await reset(); await call(6);
  const socket = new MockSocket(), seen: unknown[] = [];
  const c = await attach(6,socket,seen);
  socket.started(incomingId(99));
  socket.finished(incomingId(6),80);
  assert.equal((await c.completion).state,"AUTHENTICATION_MISMATCH");
  const row=await db.salesVoiceCall.findUniqueOrThrow({where:{providerCallId:incomingId(6)}});
  assert.equal(row.status,"ACCEPTED");
});

test("cumulative voice updates persist after matching session.started", async () => {
  await reset(); await call(7);
  const socket = new MockSocket(), seen: unknown[] = [];
  const c=await attach(7,socket,seen);
  socket.started(incomingId(7));
  socket.usage(10);
  socket.usage(14);
  socket.usage(8);
  await tick(); await tick(); await tick();
  const row=await db.salesVoiceCall.findUniqueOrThrow({where:{providerCallId:incomingId(7)}});
  assert.equal(row.lastUsageSeconds,14);
  assert.equal(row.finalizedAt,null);
  socket.drop();
  assert.equal((await c.completion).state,"UNCONFIRMED_DISCONNECT");
});

test("session.closed confirms final usage and frees only this session", async () => {
  await reset(); await call(8);
  const socket=new MockSocket(), seen: unknown[] = [];
  const c=await attach(8,socket,seen);
  socket.started(incomingId(8));
  socket.usage(12);
  socket.finished(incomingId(8),12.5);
  const result=await c.completion;
  assert.equal(result.state,"CONFIRMED_CLOSED");
  assert.equal(result.eventCount,2);
  const row=await db.salesVoiceCall.findUniqueOrThrow({where:{providerCallId:incomingId(8)}});
  assert.equal(row.status,"COMPLETED");
  assert.equal(row.finalUsageSeconds,12.5);
  assert.ok(row.finalizedAt);
});

test("sideband socket loss after usage does not falsely finalize or release capacity", async () => {
  await reset(); await call(9);
  const socket=new MockSocket(), seen: unknown[] = [];
  const c=await attach(9,socket,seen);
  socket.started(incomingId(9));
  socket.usage(20);
  await tick(); await tick();
  socket.drop();
  assert.equal((await c.completion).state,"UNCONFIRMED_DISCONNECT");
  const row=await db.salesVoiceCall.findUniqueOrThrow({where:{providerCallId:incomingId(9)}});
  assert.equal(row.status,"ACCEPTED");
  assert.equal(row.finalizedAt,null);
});

test("malformed and contradictory closure data fail closed", async () => {
  await reset(); await call(10);
  const socket=new MockSocket(), seen: unknown[] = [];
  const c=await attach(10,socket,seen);
  socket.started(incomingId(10));
  socket.finished(incomingId(99),20);
  assert.equal((await c.completion).state,"PROCESSING_ERROR");
  const row=await db.salesVoiceCall.findUniqueOrThrow({where:{providerCallId:incomingId(10)}});
  assert.equal(row.status,"ACCEPTED");
  assert.equal(row.finalizedAt,null);
});

test("malformed JSON cannot reach CRM or authorization tools", async () => {
  await reset(); await call(11);
  const socket=new MockSocket(), seen: unknown[] = [];
  const c=await attach(11,socket,seen);
  socket.emit("message", Buffer.from("{"));
  assert.equal((await c.completion).state,"PROCESSING_ERROR");
  const row=await db.salesVoiceCall.findUniqueOrThrow({where:{providerCallId:incomingId(11)}});
  assert.equal(row.prospectId,null);
  assert.equal(row.finalizedAt,null);
});
