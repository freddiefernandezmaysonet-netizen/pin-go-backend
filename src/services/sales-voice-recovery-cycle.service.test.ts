import assert from "node:assert/strict";
import { after, test } from "node:test";
import { PrismaClient } from "@prisma/client";
import { runSimulatedSalesVoiceRecoveryCycle } from "./sales-voice-recovery-cycle.service.js";
import { SalesVoiceRecoveryLease } from "./sales-voice-recovery-lease.service.js";

const url = process.env.SALES_WATCHDOG_TEST_DATABASE_URL;
assert.ok(url, "Disposable database required");
const target = new URL(url);
assert.equal(target.protocol, "postgresql:");
assert.ok(["localhost", "127.0.0.1"].includes(target.hostname));
assert.equal(target.pathname, "/pingo_sales_watchdog_test");
assert.equal(process.env.DATABASE_URL, url);
const db = new PrismaClient({ datasources: { db: { url } } });
after(async () => db.$disconnect());
const env = {
  NODE_ENV: "test", RAILWAY_ENVIRONMENT_NAME: "sales-voice-certification",
  SALES_VOICE_RECOVERY_CYCLE_SIMULATION_ENABLED: "true",
  SALES_VOICE_RECOVERY_CYCLE_RELEASE_CERTIFIED: "true",
};
const now = new Date("2030-10-13T22:00:00Z");
const a = "voice_recovery_owner_0001", b = "voice_recovery_owner_0002";
const input = (owner = a, held: Parameters<typeof runSimulatedSalesVoiceRecoveryCycle>[0]["held"] = []) => ({
  db, env, owner, held, now, ttlSeconds: 30, staleAfterSeconds: 60, maxOwned: 5,
});
const reset = () => db.salesVoiceCall.deleteMany({ where: { providerCallId: { startsWith: "live_cycle_" } } });
async function seed(id: string, status = "ACCEPTED") {
  return db.salesVoiceCall.create({ data: {
    providerCallId: id, provider: "OPENAI_LIVE_SIP", direction: "INBOUND", status,
    updatedAt: new Date(now.getTime() - 120000),
  } });
}
test("production veto performs no database reads or writes", async () => {
  const trapped = new Proxy({} as typeof db, { get() { throw new Error("DATABASE_TOUCHED"); } });
  await assert.rejects(runSimulatedSalesVoiceRecoveryCycle({
    ...input(), db: trapped, env: { ...env, NODE_ENV: "production" },
  }), /RECOVERY_CYCLE_PRODUCTION_VETO/);
});
test("competing cycles acquire one owner; call outcome and capacity stay held", async () => {
  await reset(); await seed("live_cycle_compete");
  const outcomes = await Promise.all([
    runSimulatedSalesVoiceRecoveryCycle(input(a)),
    runSimulatedSalesVoiceRecoveryCycle(input(b)),
  ]);
  const all = outcomes.flatMap(x => x.owned);
  assert.equal(all.length, 1);
  assert.equal(all[0].decision, "KEEP_CAPACITY_HELD");
  const row = await db.salesVoiceCall.findUniqueOrThrow({ where: { providerCallId: "live_cycle_compete" } });
  assert.equal(row.status, "ACCEPTED"); assert.equal(row.finalizedAt, null);
  assert.equal(row.hangupClaimedAt, null); assert.equal(row.answeredAt, null);
});
test("renewal retains epoch and does not acquire a duplicate ownership slot", async () => {
  await reset(); await seed("live_cycle_renew");
  const first = await runSimulatedSalesVoiceRecoveryCycle(input());
  const next = await runSimulatedSalesVoiceRecoveryCycle({
    ...input(a, first.owned.map(x => x.lease)), now: new Date(now.getTime() + 5000),
  });
  assert.equal(next.owned.length, 1); assert.deepEqual(next.lost, []);
  assert.equal(next.owned[0].lease.epoch, first.owned[0].lease.epoch);
  assert.equal(next.owned[0].lease.expiresAt.getTime(), now.getTime() + 35000);
});
test("new process recovers expired ownership; stale process reports loss without release", async () => {
  await reset(); await seed("live_cycle_restart");
  const old = await runSimulatedSalesVoiceRecoveryCycle(input(a));
  const afterRestart = new Date(now.getTime() + 31000);
  const resumed = await runSimulatedSalesVoiceRecoveryCycle({ ...input(b), now: afterRestart });
  assert.equal(resumed.owned.length, 1);
  assert.equal(resumed.owned[0].lease.epoch, old.owned[0].lease.epoch + 1);
  const stale = await runSimulatedSalesVoiceRecoveryCycle({
    ...input(a, old.owned.map(x => x.lease)), now: afterRestart,
  });
  assert.equal(stale.owned.length, 0); assert.deepEqual(stale.lost, ["live_cycle_restart"]);
  const row = await db.salesVoiceCall.findUniqueOrThrow({ where: { providerCallId: "live_cycle_restart" } });
  assert.equal(row.recoveryLeaseOwner, b); assert.equal(row.status, "ACCEPTED");
  assert.equal(row.finalizedAt, null);
});
test("ambiguous accept/hangup remain review-required, never retried or finalized", async () => {
  await reset(); await seed("live_cycle_accept_unknown", "ACCEPT_UNKNOWN");
  await seed("live_cycle_hangup_unknown", "HANGUP_UNKNOWN");
  const cycle = await runSimulatedSalesVoiceRecoveryCycle(input());
  assert.equal(cycle.owned.length, 2);
  assert.ok(cycle.owned.every(x => x.decision === "REQUIRE_PROVIDER_REVIEW"));
  const rows = await db.salesVoiceCall.findMany({ where: { providerCallId: { startsWith: "live_cycle_" } } });
  assert.ok(rows.every(x => x.finalizedAt === null && x.hangupClaimedAt === null));
});
test("finalized session loses ownership on renewal without rewriting its result", async () => {
  await reset(); await seed("live_cycle_finalized");
  const first = await runSimulatedSalesVoiceRecoveryCycle(input());
  await db.salesVoiceCall.update({ where: { providerCallId: "live_cycle_finalized" },
    data: { status: "COMPLETED", finalizedAt: now, finalUsageSeconds: 17 } });
  const next = await runSimulatedSalesVoiceRecoveryCycle(input(a, first.owned.map(x => x.lease)));
  assert.equal(next.owned.length, 0); assert.deepEqual(next.lost, ["live_cycle_finalized"]);
  const row = await db.salesVoiceCall.findUniqueOrThrow({ where: { providerCallId: "live_cycle_finalized" } });
  assert.equal(row.finalUsageSeconds, 17); assert.equal(row.status, "COMPLETED");
});
test("entire held batch is validated before renewing any lease", async () => {
  await reset(); await seed("live_cycle_validation");
  const lease = (await new SalesVoiceRecoveryLease(db).claim({
    sessionId: "live_cycle_validation", owner: a, now, ttlSeconds: 30,
  }))!;
  for (const held of [[lease, { ...lease, owner: b }], [lease, lease]]) {
    await assert.rejects(runSimulatedSalesVoiceRecoveryCycle({
      ...input(a, held), now: new Date(now.getTime() + 5000),
    }), /INVALID_HELD_RECOVERY_LEASE/);
  }
  const row = await db.salesVoiceCall.findUniqueOrThrow({ where: { providerCallId: "live_cycle_validation" } });
  assert.equal(row.recoveryLeaseUntil!.getTime(), now.getTime() + 30000);
});
test("bounded inventory never acquires more than configured ownership limit", async () => {
  await reset(); for (let n = 0; n < 3; n++) await seed("live_cycle_batch_" + n);
  const cycle = await runSimulatedSalesVoiceRecoveryCycle({ ...input(), maxOwned: 1 });
  assert.equal(cycle.owned.length, 1); assert.equal(cycle.hasMore, true);
  assert.equal(await db.salesVoiceCall.count({
    where: { providerCallId: { startsWith: "live_cycle_" }, recoveryLeaseOwner: a },
  }), 1);
});
