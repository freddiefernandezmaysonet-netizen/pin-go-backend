import assert from "node:assert/strict";
import { after, test } from "node:test";
import { EventEmitter } from "node:events";
import { PrismaClient } from "@prisma/client";
import { SalesVoiceRecoveryLease, SALES_VOICE_MAX_RECOVERY_EPOCHS } from "./sales-voice-recovery-lease.service.js";
import { runSimulatedSalesVoiceRecoveryCycle } from "./sales-voice-recovery-cycle.service.js";
import { SimulatedSalesVoiceRecoverySupervisor } from "./sales-voice-recovery-supervisor.service.js";

const url = process.env.SALES_WATCHDOG_TEST_DATABASE_URL;
assert.ok(url, "Disposable database required");
const target = new URL(url);
assert.equal(target.protocol, "postgresql:");
assert.ok(["localhost", "127.0.0.1"].includes(target.hostname));
assert.equal(target.pathname, "/pingo_sales_watchdog_test");
assert.equal(process.env.DATABASE_URL, url);
const db = new PrismaClient({ datasources: { db: { url } } });
after(async () => db.$disconnect());
const id = "live_recovery_budget_test", owner = "voice_budget_owner_0001";
const env = {
  NODE_ENV: "test", RAILWAY_ENVIRONMENT_NAME: "sales-voice-certification",
  SALES_VOICE_RECOVERY_CYCLE_SIMULATION_ENABLED: "true",
  SALES_VOICE_RECOVERY_CYCLE_RELEASE_CERTIFIED: "true",
  SALES_VOICE_RECOVERY_SUPERVISOR_SIMULATION_ENABLED: "true",
  SALES_VOICE_RECOVERY_SUPERVISOR_RELEASE_CERTIFIED: "true",
  SALES_VOICE_OPENAI_API_KEY: "sk-synthetic-budget",
};
async function seed(epoch = 0, status = "ACCEPTED", provider = "OPENAI_LIVE_SIP") {
  await db.salesVoiceCall.deleteMany({});
  await db.salesVoiceCall.create({ data: {
    providerCallId: id, provider, direction: "INBOUND", status,
    recoveryLeaseEpoch: epoch, updatedAt: new Date(0),
  } });
}
const row = () => db.salesVoiceCall.findUniqueOrThrow({ where: { providerCallId: id } });
const request = (who = owner) => ({ sessionId: id, owner: who, now: new Date(), ttlSeconds: 120 });
async function expire() {
  await db.salesVoiceCall.update({ where: { providerCallId: id },
    data: { recoveryLeaseUntil: new Date(0), updatedAt: new Date(0) } });
}
class Socket extends EventEmitter { close() { this.emit("close"); } }
function engine(who: string, connect: () => Socket) {
  return new SimulatedSalesVoiceRecoverySupervisor({
    db, env, owner: who, ttlSeconds: 120, staleAfterSeconds: 60, maxOwned: 5, connect,
  });
}
test("concurrent claim at the final budget slot admits only one owner", async () => {
  await seed(SALES_VOICE_MAX_RECOVERY_EPOCHS - 1);
  const service = new SalesVoiceRecoveryLease(db);
  const claims = await Promise.all([service.claim(request(owner)), service.claim(request("voice_budget_owner_0002"))]);
  assert.equal(claims.filter(Boolean).length, 1);
  assert.equal((await row()).recoveryLeaseEpoch, SALES_VOICE_MAX_RECOVERY_EPOCHS);
  await expire();
  assert.equal(await service.claim(request("voice_budget_owner_0003")), null);
  assert.equal((await row()).status, "ACCEPTED"); assert.equal((await row()).finalizedAt, null);
});
test("release never resets the lifetime counter or grants another acquisition", async () => {
  await seed(SALES_VOICE_MAX_RECOVERY_EPOCHS - 1);
  const service = new SalesVoiceRecoveryLease(db), lease = (await service.claim(request()))!;
  assert.equal(await service.release(lease, new Date()), true);
  assert.equal(await service.claim(request("voice_budget_owner_0002")), null);
  const stored = await row();
  assert.equal(stored.recoveryLeaseEpoch, SALES_VOICE_MAX_RECOVERY_EPOCHS);
  assert.equal(stored.status, "ACCEPTED"); assert.equal(stored.finalizedAt, null);
});
test("fresh processes cannot obtain unlimited attach attempts across restarts", async () => {
  await seed(); let attaches = 0;
  for (let n = 0; n < SALES_VOICE_MAX_RECOVERY_EPOCHS; n++) {
    const process = engine("voice_budget_process_000" + n, () => { attaches++; return new Socket(); });
    assert.equal((await process.sweep()).opened, 1);
    process.stop(); await expire();
  }
  const denied = engine("voice_budget_process_9999", () => { attaches++; return new Socket(); });
  const result = await denied.sweep();
  assert.equal(result.opened, 0); assert.deepEqual(result.exhausted, [id]);
  assert.equal(attaches, SALES_VOICE_MAX_RECOVERY_EPOCHS);
  assert.equal((await row()).status, "ACCEPTED"); assert.equal((await row()).finalizedAt, null);
  denied.stop();
});
test("last valid owner may renew without consuming another acquisition", async () => {
  await seed(SALES_VOICE_MAX_RECOVERY_EPOCHS - 1); let attaches = 0;
  const process = engine(owner, () => { attaches++; return new Socket(); });
  await process.sweep();
  assert.equal((await process.sweep()).opened, 0);
  assert.equal(process.snapshot()[0].phase, "WATCHING");
  assert.equal(attaches, 1); assert.equal((await row()).recoveryLeaseEpoch, SALES_VOICE_MAX_RECOVERY_EPOCHS);
  process.stop();
});
test("review-only acquisitions consume budget conservatively without provider attach", async () => {
  await seed(0, "ACCEPT_UNKNOWN"); let attaches = 0;
  for (let n = 0; n < SALES_VOICE_MAX_RECOVERY_EPOCHS; n++) {
    const process = engine("voice_budget_review_000" + n, () => { attaches++; return new Socket(); });
    await process.sweep(); assert.equal(process.snapshot()[0].phase, "REVIEW");
    process.stop(); await expire();
  }
  const denied = engine(owner, () => { attaches++; return new Socket(); });
  assert.deepEqual((await denied.sweep()).exhausted, [id]);
  assert.equal(attaches, 0); assert.equal((await row()).status, "ACCEPT_UNKNOWN");
  assert.equal((await row()).hangupClaimedAt, null);
  denied.stop();
});
test("corrupt negative counters cannot bypass the atomic budget predicate", async () => {
  await seed(-1);
  assert.equal(await new SalesVoiceRecoveryLease(db).claim(request()), null);
  assert.equal((await row()).recoveryLeaseEpoch, -1); assert.equal((await row()).recoveryLeaseOwner, null);
});
test("budget does not authorize unrelated providers or already completed calls", async () => {
  await seed(0, "ACCEPTED", "TWILIO");
  assert.equal(await new SalesVoiceRecoveryLease(db).claim(request()), null);
  assert.equal((await row()).recoveryLeaseEpoch, 0);
  await seed(0, "COMPLETED");
  assert.equal(await new SalesVoiceRecoveryLease(db).claim(request()), null);
  assert.equal((await row()).status, "COMPLETED");
});
test("cycle reports exhausted session without changing usage, outcome or held capacity", async () => {
  await seed(SALES_VOICE_MAX_RECOVERY_EPOCHS, "HANGUP_SENT");
  const result = await runSimulatedSalesVoiceRecoveryCycle({
    db, env, owner, now: new Date(), ttlSeconds: 120, staleAfterSeconds: 60, maxOwned: 5, held: [],
  });
  assert.equal(result.owned.length, 0); assert.deepEqual(result.exhausted, [id]);
  const stored = await row();
  assert.equal(stored.status, "HANGUP_SENT"); assert.equal(stored.finalizedAt, null);
  assert.equal(stored.finalUsageSeconds, null); assert.equal(stored.recoveryLeaseEpoch, SALES_VOICE_MAX_RECOVERY_EPOCHS);
});
