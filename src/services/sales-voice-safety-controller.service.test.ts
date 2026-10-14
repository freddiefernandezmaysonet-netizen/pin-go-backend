import assert from "node:assert/strict";
import { after, test } from "node:test";
import { EventEmitter } from "node:events";
import { PrismaClient } from "@prisma/client";
import { SimulatedSalesVoiceSafetyController } from "./sales-voice-safety-controller.service.js";
import type { HangupHTTP } from "./sales-voice-live-watchdog.service.js";

const url = process.env.SALES_SIDEBAND_TEST_DATABASE_URL;
assert.ok(url, "Disposable database required");
const target = new URL(url);
assert.equal(target.protocol, "postgresql:");
assert.ok(["localhost", "127.0.0.1"].includes(target.hostname));
assert.equal(target.pathname, "/pingo_sales_sideband_test");
assert.equal(process.env.DATABASE_URL, url);
const db = new PrismaClient({ datasources: { db: { url } } });
after(async () => db.$disconnect());
const id = "live_safety_test", owner = "voice_safety_owner_0001";
const env = () => ({
  NODE_ENV: "test", RAILWAY_ENVIRONMENT_NAME: "sales-voice-certification",
  SALES_VOICE_RECOVERY_CYCLE_SIMULATION_ENABLED: "true",
  SALES_VOICE_RECOVERY_CYCLE_RELEASE_CERTIFIED: "true",
  SALES_VOICE_RECOVERY_SUPERVISOR_SIMULATION_ENABLED: "true",
  SALES_VOICE_RECOVERY_SUPERVISOR_RELEASE_CERTIFIED: "true",
  SALES_VOICE_SAFETY_CONTROLLER_SIMULATION_ENABLED: "true",
  SALES_VOICE_SAFETY_CONTROLLER_RELEASE_CERTIFIED: "true",
  SALES_VOICE_OPENAI_API_KEY: "sk-synthetic-safety-commercial",
});
class Socket extends EventEmitter { closed = false; close() { this.closed = true; this.emit("close"); } }
function fixture(who = owner, hangup: HangupHTTP = async () => ({ status: 200 })) {
  const sockets: Socket[] = [];
  return { sockets, options: {
    db, env: env(), owner: who, ttlSeconds: 120, staleAfterSeconds: 60, maxOwned: 3,
    maxCallSeconds: 60, maxSweepIntervalSeconds: 10,
    admissionLimits: { enabled: true, maxConcurrentCalls: 3, monthlyBudgetCents: 10000,
      estimatedCentsPerMinute: 25, reservedSecondsPerCall: 90 },
    connect: () => { const socket = new Socket(); sockets.push(socket); return socket; }, hangup,
  } };
}
async function seed(ageSeconds = 70, epoch = 0) {
  await db.salesVoiceCall.deleteMany({});
  const start = new Date(Date.now() - ageSeconds * 1000);
  await db.salesVoiceCall.create({ data: {
    providerCallId: id, provider: "OPENAI_LIVE_SIP", direction: "INBOUND", status: "ACCEPTED",
    startedAt: start, answeredAt: start, updatedAt: new Date(0), recoveryLeaseEpoch: epoch,
  } });
}
const row = () => db.salesVoiceCall.findUniqueOrThrow({ where: { providerCallId: id } });
test("production and guest credentials cannot authorize safety controller", () => {
  const f = fixture(), trapped = new Proxy(db, { get() { throw new Error("DATABASE_TOUCHED"); } });
  assert.throws(() => new SimulatedSalesVoiceSafetyController({
    ...f.options, db: trapped, env: { ...env(), NODE_ENV: "production" },
  }), /SAFETY_CONTROLLER_PRODUCTION_VETO/);
  const { SALES_VOICE_OPENAI_API_KEY: ignored, ...withoutCommercial } = env();
  assert.throws(() => new SimulatedSalesVoiceSafetyController({
    ...f.options, db: trapped, env: { ...withoutCommercial, OPENAI_API_KEY: "sk-guest-never-authorizes" },
  }), /COMMERCIAL_SAFETY_KEY_REQUIRED/);
});
test("duration reservation must include sweep delay and provider timeout, within budget", () => {
  const f = fixture();
  for (const admissionLimits of [
    { ...f.options.admissionLimits, reservedSecondsPerCall: 60 },
    { ...f.options.admissionLimits, reservedSecondsPerCall: 80 },
    { ...f.options.admissionLimits, monthlyBudgetCents: 49 },
    { ...f.options.admissionLimits, maxConcurrentCalls: 2 },
  ]) assert.throws(() => new SimulatedSalesVoiceSafetyController({
    ...f.options, admissionLimits,
  }), /SAFETY_RESERVATION_LIMITS_MISMATCH/);
  assert.equal(f.sockets.length, 0);
});
test("duration guardian issues one bound request but HTTP ack does not finalize", async () => {
  await seed(); let calls = 0;
  const f = fixture(owner, async (url, request) => {
    calls++; assert.equal(url, "https://api.openai.com/v1/live/sessions/" + id + "/hangup");
    assert.equal(request.headers.Authorization, "Bearer sk-synthetic-safety-commercial");
    return { status: 200 };
  });
  const controller = new SimulatedSalesVoiceSafetyController(f.options);
  const first = await controller.tick();
  assert.equal(first.watchdog!.claimed, 1); assert.equal(first.watchdog!.sent, 1);
  assert.equal((await controller.tick()).watchdog!.claimed, 0); assert.equal(calls, 1);
  const stored = await row();
  assert.equal(stored.status, "HANGUP_SENT"); assert.equal(stored.finalizedAt, null);
  controller.stop();
});
test("ambiguous timeout survives controller restart and is never blindly retried", async () => {
  await seed(); let calls = 0;
  const hangup: HangupHTTP = async () => { calls++; throw new Error("synthetic timeout"); };
  const first = new SimulatedSalesVoiceSafetyController(fixture(owner, hangup).options);
  assert.equal((await first.tick()).watchdog!.unknown, 1); first.stop();
  const restarted = new SimulatedSalesVoiceSafetyController(fixture("voice_safety_owner_0002", hangup).options);
  assert.equal((await restarted.tick()).watchdog!.claimed, 0);
  assert.equal(calls, 1); assert.equal((await row()).status, "HANGUP_UNKNOWN");
  assert.equal((await row()).finalizedAt, null); restarted.stop();
});
test("two controllers cannot duplicate the global persisted hangup claim", async () => {
  await seed(); let calls = 0;
  const hangup: HangupHTTP = async () => { calls++; return { status: 200 }; };
  const a = new SimulatedSalesVoiceSafetyController(fixture(owner, hangup).options);
  const b = new SimulatedSalesVoiceSafetyController(fixture("voice_safety_owner_0002", hangup).options);
  const outcomes = await Promise.all([a.tick(), b.tick()]);
  assert.equal(outcomes.reduce((n, x) => n + x.watchdog!.claimed, 0), 1);
  assert.equal(calls, 1); assert.equal((await row()).finalizedAt, null);
  a.stop(); b.stop();
});
test("authenticated matching session.closed finalizes after duration hangup", async () => {
  await seed(); const f = fixture(), controller = new SimulatedSalesVoiceSafetyController(f.options);
  await controller.tick(); const completion = controller.completion(id)!;
  f.sockets[0].emit("open");
  f.sockets[0].emit("message", JSON.stringify({
    type: "session.closed", event_id: "safety_closed", session: { id },
    usage: { seconds: 20 }, reason: "close_requested",
  }));
  assert.equal((await completion).state, "CONFIRMED_CLOSED");
  assert.equal((await row()).status, "COMPLETED"); assert.equal((await row()).finalUsageSeconds, 20);
  assert.equal((await controller.tick()).watchdog!.claimed, 0);
  assert.equal(controller.snapshot().length, 0); controller.stop();
});
test("recent answer is not terminated merely because metadata was received earlier", async () => {
  await seed(3600);
  await db.salesVoiceCall.update({ where: { providerCallId: id }, data: { answeredAt: new Date(), updatedAt: new Date(0) } });
  let calls = 0; const f = fixture(owner, async () => { calls++; return { status: 200 }; });
  const controller = new SimulatedSalesVoiceSafetyController(f.options);
  assert.equal((await controller.tick()).watchdog!.claimed, 0);
  assert.equal(calls, 0); assert.equal((await row()).status, "ACCEPTED"); controller.stop();
});
test("unanswered session uses persisted start time for duration guardian", async () => {
  await seed(); await db.salesVoiceCall.update({ where: { providerCallId: id }, data: { answeredAt: null, updatedAt: new Date(0) } });
  const controller = new SimulatedSalesVoiceSafetyController(fixture().options);
  assert.equal((await controller.tick()).watchdog!.claimed, 1);
  assert.equal((await row()).status, "HANGUP_SENT"); controller.stop();
});
test("release gate disablement stops observers and prevents further duration requests", async () => {
  await seed(1); let calls = 0;
  const f = fixture(owner, async () => { calls++; return { status: 200 }; });
  const controller = new SimulatedSalesVoiceSafetyController(f.options);
  await controller.tick();
  f.options.env.SALES_VOICE_SAFETY_CONTROLLER_RELEASE_CERTIFIED = "false";
  assert.equal((await controller.tick()).state, "DISABLED");
  assert.equal(f.sockets[0].closed, true); assert.equal(calls, 0);
  assert.equal((await row()).status, "ACCEPTED"); assert.equal((await row()).hangupClaimedAt, null);
});
test("exhausted recovery budget does not disable independent duration guardian", async () => {
  await seed(70, 3); let calls = 0;
  const f = fixture(owner, async () => { calls++; return { status: 200 }; });
  const controller = new SimulatedSalesVoiceSafetyController(f.options), result = await controller.tick();
  assert.deepEqual(result.recovery!.exhausted, [id]); assert.equal(result.recovery!.opened, 0);
  assert.equal(result.watchdog!.claimed, 1); assert.equal(calls, 1);
  assert.equal((await row()).status, "HANGUP_SENT"); assert.equal((await row()).finalizedAt, null);
  controller.stop();
});

test("caller mutation cannot enlarge validated duration after construction", async () => {
  await seed(); const f = fixture(), controller = new SimulatedSalesVoiceSafetyController(f.options);
  f.options.maxCallSeconds = 3600;
  f.options.admissionLimits.reservedSecondsPerCall = 3600;
  assert.equal((await controller.tick()).watchdog!.claimed, 1);
  assert.equal((await row()).status, "HANGUP_SENT"); controller.stop();
});
