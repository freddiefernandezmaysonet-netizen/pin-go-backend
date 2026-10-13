import assert from "node:assert/strict";
import { after, test } from "node:test";
import { EventEmitter } from "node:events";
import { PrismaClient } from "@prisma/client";
import { SimulatedSalesVoiceRecoverySupervisor } from "./sales-voice-recovery-supervisor.service.js";

const url = process.env.SALES_SIDEBAND_TEST_DATABASE_URL;
assert.ok(url, "Disposable database required");
const target = new URL(url);
assert.equal(target.protocol, "postgresql:");
assert.ok(["localhost", "127.0.0.1"].includes(target.hostname));
assert.equal(target.pathname, "/pingo_sales_sideband_test");
assert.equal(process.env.DATABASE_URL, url);
const db = new PrismaClient({ datasources: { db: { url } } });
after(async () => db.$disconnect());
const owner = "voice_supervisor_owner_0001", nextOwner = "voice_supervisor_owner_0002";
const env = () => ({
  NODE_ENV: "test", RAILWAY_ENVIRONMENT_NAME: "sales-voice-certification",
  SALES_VOICE_RECOVERY_CYCLE_SIMULATION_ENABLED: "true",
  SALES_VOICE_RECOVERY_CYCLE_RELEASE_CERTIFIED: "true",
  SALES_VOICE_RECOVERY_SUPERVISOR_SIMULATION_ENABLED: "true",
  SALES_VOICE_RECOVERY_SUPERVISOR_RELEASE_CERTIFIED: "true",
  SALES_VOICE_OPENAI_API_KEY: "sk-synthetic-commercial",
});
class Socket extends EventEmitter {
  closed = false;
  close() { this.closed = true; this.emit("close"); }
}
async function reset() { await db.salesVoiceCall.deleteMany({}); }
async function seed(id: string, status = "ACCEPTED") {
  await db.salesVoiceCall.create({ data: {
    providerCallId: id, provider: "OPENAI_LIVE_SIP", direction: "INBOUND", status,
    updatedAt: new Date(0),
  } });
}
const row = (id: string) => db.salesVoiceCall.findUniqueOrThrow({ where: { providerCallId: id } });
function input(ownerId = owner) {
  const sockets: Socket[] = [];
  const options = {
    db, env: env(), owner: ownerId, ttlSeconds: 120, staleAfterSeconds: 60, maxOwned: 5,
    connect: () => { const socket = new Socket(); sockets.push(socket); return socket; },
  };
  return { options, sockets };
}
test("production veto and missing commercial key touch no database or transport", () => {
  const trapped = new Proxy(db, { get() { throw new Error("DATABASE_TOUCHED"); } });
  const fixture = input();
  assert.throws(() => new SimulatedSalesVoiceRecoverySupervisor({
    ...fixture.options, db: trapped, env: { ...env(), NODE_ENV: "production" },
  }), /RECOVERY_SUPERVISOR_PRODUCTION_VETO/);
  const { SALES_VOICE_OPENAI_API_KEY: ignored, ...withoutCommercial } = env();
  assert.throws(() => new SimulatedSalesVoiceRecoverySupervisor({
    ...fixture.options, db: trapped, env: { ...withoutCommercial, OPENAI_API_KEY: "sk-guest-must-not-authorize" },
  }), /COMMERCIAL_RECOVERY_KEY_REQUIRED/);
  assert.equal(fixture.sockets.length, 0);
});
test("renewal connects accepted sessions once, while ambiguous sessions remain review-only", async () => {
  await reset(); await seed("live_supervisor_accepted"); await seed("live_supervisor_ambiguous", "ACCEPT_UNKNOWN");
  const fixture = input(), engine = new SimulatedSalesVoiceRecoverySupervisor(fixture.options);
  assert.equal((await engine.sweep()).opened, 1);
  assert.equal((await engine.sweep()).opened, 0);
  assert.equal(fixture.sockets.length, 1);
  assert.equal(engine.snapshot().find(x => x.sessionId === "live_supervisor_ambiguous")!.phase, "REVIEW");
  assert.equal((await row("live_supervisor_accepted")).recoveryLeaseEpoch, 1);
  engine.stop();
});
test("confirmed matching closure is persisted, then removed without another attach", async () => {
  await reset(); const id = "live_supervisor_closed"; await seed(id);
  const fixture = input(), engine = new SimulatedSalesVoiceRecoverySupervisor(fixture.options);
  await engine.sweep(); const completion = engine.completion(id)!;
  fixture.sockets[0].emit("open");
  fixture.sockets[0].emit("message", JSON.stringify({
    type: "session.closed", event_id: "closure_1", session: { id },
    usage: { seconds: 17 }, reason: "remote_hangup",
  }));
  assert.equal((await completion).state, "CONFIRMED_CLOSED");
  assert.equal((await row(id)).finalUsageSeconds, 17);
  await engine.sweep();
  assert.equal(engine.snapshot().length, 0); assert.equal(fixture.sockets.length, 1);
  engine.stop();
});
test("disconnect is not retried in the same epoch and cannot release held capacity", async () => {
  await reset(); const id = "live_supervisor_disconnect"; await seed(id);
  const fixture = input(), engine = new SimulatedSalesVoiceRecoverySupervisor(fixture.options);
  await engine.sweep(); const completion = engine.completion(id)!;
  fixture.sockets[0].emit("close");
  assert.equal((await completion).state, "UNCONFIRMED_DISCONNECT");
  await engine.sweep();
  assert.equal(fixture.sockets.length, 1); assert.equal(engine.snapshot()[0].phase, "DISCONNECTED");
  const stored = await row(id);
  assert.equal(stored.status, "ACCEPTED"); assert.equal(stored.finalizedAt, null);
  assert.equal(stored.hangupClaimedAt, null);
  engine.stop();
});
test("failed attach reserves the attempt and is not replayed blindly", async () => {
  await reset(); const id = "live_supervisor_attach_error"; await seed(id);
  const fixture = input(); let attempts = 0;
  const engine = new SimulatedSalesVoiceRecoverySupervisor({
    ...fixture.options, connect: () => { attempts++; throw new Error("synthetic transport unavailable"); },
  });
  assert.equal((await engine.sweep()).opened, 0); await engine.sweep();
  assert.equal(attempts, 1); assert.equal(engine.snapshot()[0].phase, "DISCONNECTED");
  assert.equal((await row(id)).finalizedAt, null);
  engine.stop();
});
test("replacement process acquires expired ownership; old sweep stops only its observer", async () => {
  await reset(); const id = "live_supervisor_restart"; await seed(id);
  const first = input(), old = new SimulatedSalesVoiceRecoverySupervisor(first.options);
  await old.sweep(); const completion = old.completion(id)!;
  await db.salesVoiceCall.update({ where: { providerCallId: id },
    data: { recoveryLeaseUntil: new Date(0), updatedAt: new Date(0) } });
  const second = input(nextOwner), replacement = new SimulatedSalesVoiceRecoverySupervisor(second.options);
  assert.equal((await replacement.sweep()).opened, 1);
  const result = await old.sweep();
  assert.deepEqual(result.lost, [id]); assert.equal(first.sockets[0].closed, true);
  assert.equal((await completion).state, "UNCONFIRMED_DISCONNECT");
  const stored = await row(id);
  assert.equal(stored.recoveryLeaseOwner, nextOwner); assert.equal(stored.recoveryLeaseEpoch, 2);
  assert.equal(stored.status, "ACCEPTED"); assert.equal(stored.finalizedAt, null);
  assert.equal(stored.hangupClaimedAt, null);
  old.stop(); replacement.stop();
});
test("disabling release gate stops observers before another clock/query cycle", async () => {
  await reset(); const id = "live_supervisor_disable"; await seed(id);
  const fixture = input(); let reads = 0;
  const proxy = new Proxy(db, { get(target, key) {
    if (key === "$queryRaw") return (...args: unknown[]) => {
      reads++; return Reflect.apply(target.$queryRaw, target, args);
    };
    const value = Reflect.get(target, key);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  const engine = new SimulatedSalesVoiceRecoverySupervisor({ ...fixture.options, db: proxy });
  await engine.sweep(); const before = reads;
  fixture.options.env.SALES_VOICE_RECOVERY_SUPERVISOR_RELEASE_CERTIFIED = "false";
  assert.equal((await engine.sweep()).state, "DISABLED"); assert.equal(reads, before);
  assert.equal(fixture.sockets[0].closed, true); assert.equal(engine.snapshot().length, 0);
  assert.equal((await row(id)).status, "ACCEPTED");
});
test("overlapping sweeps fail before a second database cycle", async () => {
  await reset(); const fixture = input();
  let release!: () => void; const barrier = new Promise<void>(resolve => { release = resolve; });
  const proxy = new Proxy(db, { get(target, key) {
    if (key === "$queryRaw") return async (...args: unknown[]) => {
      await barrier; return Reflect.apply(target.$queryRaw, target, args);
    };
    const value = Reflect.get(target, key);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  const engine = new SimulatedSalesVoiceRecoverySupervisor({ ...fixture.options, db: proxy });
  const first = engine.sweep();
  await assert.rejects(engine.sweep(), /RECOVERY_SUPERVISOR_CYCLE_BUSY/);
  release(); await first;
  assert.equal(fixture.sockets.length, 0); engine.stop();
});
test("database-clock failure stops active observer without changing call outcome", async () => {
  await reset(); const id = "live_supervisor_db_failure"; await seed(id);
  const fixture = input(); let fail = false;
  const proxy = new Proxy(db, { get(target, key) {
    if (key === "$queryRaw") return (...args: unknown[]) => {
      if (fail) throw new Error("synthetic database unavailable");
      return Reflect.apply(target.$queryRaw, target, args);
    };
    const value = Reflect.get(target, key);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  const engine = new SimulatedSalesVoiceRecoverySupervisor({ ...fixture.options, db: proxy });
  await engine.sweep(); fail = true;
  await assert.rejects(engine.sweep(), /RECOVERY_SUPERVISOR_FAILED_CLOSED/);
  assert.equal(fixture.sockets[0].closed, true); assert.equal(engine.snapshot().length, 0);
  const stored = await row(id);
  assert.equal(stored.status, "ACCEPTED"); assert.equal(stored.finalizedAt, null);
});
