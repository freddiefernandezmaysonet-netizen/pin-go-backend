import assert from "node:assert/strict";
import { after, test } from "node:test";
import { EventEmitter } from "node:events";
import { PrismaClient } from "@prisma/client";
import { SalesVoiceRecoveryLease } from "./sales-voice-recovery-lease.service.js";
import { observeExistingLiveSession } from "./sales-voice-sideband-supervisor.service.js";
import { applyFencedSalesVoiceObservation } from "./sales-voice-recovery-observation.service.js";

const url = process.env.SALES_SIDEBAND_TEST_DATABASE_URL;
assert.ok(url, "Disposable database required");
const target = new URL(url);
assert.equal(target.protocol, "postgresql:");
assert.ok(["localhost", "127.0.0.1"].includes(target.hostname));
assert.equal(target.pathname, "/pingo_sales_sideband_test");
assert.equal(process.env.DATABASE_URL, url);
const db = new PrismaClient({ datasources: { db: { url } } });
after(async () => db.$disconnect());
const owner = "voice_observation_owner_0001";
const nextOwner = "voice_observation_owner_0002";
const id = "live_observation_test";
class Socket extends EventEmitter {
  closed = false;
  close() { this.closed = true; this.emit("close"); }
}
const usage = (seconds = 17) => ({ type: "session.usage.updated", event_id: "usage_1", usage: { seconds } });
const closed = (seconds = 20) => ({
  type: "session.closed", event_id: "closed_1", session: { id },
  usage: { seconds }, reason: "remote_hangup",
});
async function setup(status = "ACCEPTED") {
  await db.salesVoiceCall.deleteMany({});
  await db.salesVoiceCall.create({ data: {
    providerCallId: id, provider: "OPENAI_LIVE_SIP", direction: "INBOUND", status,
  } });
  const lease = (await new SalesVoiceRecoveryLease(db).claim({
    sessionId: id, owner, now: new Date(), ttlSeconds: 120,
  }))!;
  assert.ok(lease);
  return lease;
}
const row = () => db.salesVoiceCall.findUniqueOrThrow({ where: { providerCallId: id } });
async function monitor(lease: Awaited<ReturnType<typeof setup>>) {
  const socket = new Socket();
  const observations: string[] = [];
  const session = await observeExistingLiveSession({
    db, sessionId: id, apiKey: "sk-synthetic-observation", enabled: true,
    recoveryLease: lease, connect: () => socket,
    onObservation: kind => { observations.push(kind); },
  });
  socket.emit("open");
  return { ...session, socket, observations };
}
test("valid owner stores monotonic usage and authenticated matching final close", async () => {
  const lease = await setup();
  const session = await monitor(lease);
  session.socket.emit("message", JSON.stringify(usage(17)));
  session.socket.emit("message", JSON.stringify(usage(9)));
  session.socket.emit("message", JSON.stringify(closed(20)));
  assert.equal((await session.completion).state, "CONFIRMED_CLOSED");
  assert.deepEqual(session.observations, ["usage", "usage", "closed"]);
  const stored = await row();
  assert.equal(stored.status, "COMPLETED"); assert.equal(stored.finalUsageSeconds, 20);
});
test("expired database lease vetoes attach even when token expiry is in the future", async () => {
  const lease = await setup();
  await db.salesVoiceCall.update({ where: { providerCallId: id }, data: { recoveryLeaseUntil: new Date(0) } });
  let attaches = 0;
  await assert.rejects(observeExistingLiveSession({
    db, sessionId: id, apiKey: "sk-synthetic-observation", enabled: true,
    recoveryLease: { ...lease, expiresAt: new Date("2099-01-01") },
    connect: () => { attaches++; return new Socket(); },
  }), /RECOVERY_OWNERSHIP_LOST/);
  assert.equal(attaches, 0); assert.equal((await row()).status, "ACCEPTED");
});
test("expiry after attach closes observer; queued final event cannot release capacity", async () => {
  const lease = await setup();
  const session = await monitor(lease);
  await db.salesVoiceCall.update({ where: { providerCallId: id }, data: { recoveryLeaseUntil: new Date(0) } });
  session.socket.emit("message", JSON.stringify(usage()));
  session.socket.emit("message", JSON.stringify(closed()));
  assert.equal((await session.completion).state, "OWNERSHIP_LOST");
  assert.equal(session.socket.closed, true); assert.deepEqual(session.observations, []);
  const stored = await row();
  assert.equal(stored.status, "ACCEPTED"); assert.equal(stored.lastUsageSeconds, null);
  assert.equal(stored.finalizedAt, null); assert.equal(stored.hangupClaimedAt, null);
});
test("takeover fences old observer, while the new owner can confirm closure", async () => {
  const lease = await setup();
  const old = await monitor(lease);
  await db.salesVoiceCall.update({ where: { providerCallId: id }, data: { recoveryLeaseUntil: new Date(0) } });
  const next = (await new SalesVoiceRecoveryLease(db).claim({
    sessionId: id, owner: nextOwner, now: new Date(), ttlSeconds: 120,
  }))!;
  const current = await monitor(next);
  old.socket.emit("message", JSON.stringify(closed()));
  assert.equal((await old.completion).state, "OWNERSHIP_LOST");
  assert.equal((await row()).finalizedAt, null);
  current.socket.emit("message", JSON.stringify(closed()));
  assert.equal((await current.completion).state, "CONFIRMED_CLOSED");
  assert.equal((await row()).recoveryLeaseOwner, nextOwner);
});
test("fence reads database time after row-lock wait, never commits an expired observation", async () => {
  const lease = await setup();
  let pending!: Promise<void>;
  await db.$transaction(async tx => {
    await tx.$queryRaw`SELECT "id" FROM "SalesVoiceCall" WHERE "providerCallId" = ${id} FOR UPDATE`;
    pending = applyFencedSalesVoiceObservation(db, lease, {
      type: "usage", sessionId: id, eventId: "locked_usage", seconds: 77,
    });
    // The other transaction must acquire this lock before reading its clock.
    await tx.salesVoiceCall.update({ where: { providerCallId: id }, data: { recoveryLeaseUntil: new Date(0) } });
  });
  await assert.rejects(pending, /RECOVERY_OWNERSHIP_LOST/);
  assert.equal((await row()).lastUsageSeconds, null);
});
test("session mismatch and regressive final usage preserve held outcome", async () => {
  const lease = await setup();
  await assert.rejects(applyFencedSalesVoiceObservation(db, lease, {
    type: "usage", sessionId: "live_wrong_session", eventId: "wrong", seconds: 17,
  }), /RECOVERY_OBSERVATION_SESSION_MISMATCH/);
  await applyFencedSalesVoiceObservation(db, lease, {
    type: "usage", sessionId: id, eventId: "usage_1", seconds: 30,
  });
  const session = await monitor(lease);
  session.socket.emit("message", JSON.stringify(closed(20)));
  assert.equal((await session.completion).state, "PROCESSING_ERROR");
  const stored = await row();
  assert.equal(stored.lastUsageSeconds, 30); assert.equal(stored.finalizedAt, null);
  assert.equal(stored.status, "ACCEPTED");
});
test("socket disconnect retains capacity and never sends hangup or finalization", async () => {
  const lease = await setup("ACCEPT_UNKNOWN");
  const session = await monitor(lease);
  session.disconnect();
  assert.equal((await session.completion).state, "UNCONFIRMED_DISCONNECT");
  const stored = await row();
  assert.equal(stored.status, "ACCEPT_UNKNOWN"); assert.equal(stored.finalizedAt, null);
  assert.equal(stored.hangupClaimedAt, null);
});
