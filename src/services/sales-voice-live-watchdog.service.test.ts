import assert from "node:assert/strict";
import { after, test } from "node:test";
import { PrismaClient } from "@prisma/client";
import { SalesVoiceLiveAdmission } from "./sales-voice-live-admission.service.js";
import {
  SalesVoiceLiveWatchdog, SalesVoiceWatchdogError,
  parseBoundLiveSidebandEvent, noteLiveUsage, finalizeLiveClosed,
  postOneLiveHangup, type HangupHTTP, type SidebandObservation,
} from "./sales-voice-live-watchdog.service.js";

const url = process.env.SALES_WATCHDOG_TEST_DATABASE_URL;
assert.ok(url, "Disposable test database is mandatory");
const u = new URL(url);
assert.equal(u.protocol, "postgresql:");
assert.ok(["127.0.0.1", "localhost"].includes(u.hostname));
assert.equal(u.pathname, "/pingo_sales_watchdog_test");
assert.equal(process.env.DATABASE_URL, url);
const db = new PrismaClient({ datasources: { db: { url } } });
after(async () => db.$disconnect());
const watchdog = new SalesVoiceLiveWatchdog(db);
const admission = new SalesVoiceLiveAdmission(db);
const liveId = (i: number) => "live_test_watchdog_" + i;
const past = (seconds: number) => new Date(Date.now() - seconds * 1000);
const config = (overrides: Record<string, unknown> = {}) => ({
  enabled: true, maxCallSeconds: 300, batchSize: 10, ...overrides,
});
const capacity = (overrides: Record<string, unknown> = {}) => ({
  enabled: true, maxConcurrentCalls: 1, monthlyBudgetCents: 100000,
  estimatedCentsPerMinute: 20, reservedSecondsPerCall: 300, ...overrides,
});
const error = (code: string) => (e: unknown) =>
  e instanceof SalesVoiceWatchdogError && e.code === code;

async function reset(): Promise<void> {
  await db.salesVoiceCall.deleteMany({ where: { provider: { in: ["OPENAI_LIVE_SIP", "TWILIO"] } } });
}
async function createCall(i: number, status = "ACCEPTED", ageSeconds = 400) {
  return db.salesVoiceCall.create({ data: {
    provider: "OPENAI_LIVE_SIP", providerCallId: liveId(i),
    direction: "INBOUND", status, startedAt: past(ageSeconds + 10),
    answeredAt: past(ageSeconds),
  } });
}
function observation(sessionId: string, seconds: number) {
  return parseBoundLiveSidebandEvent({
    type: "session.usage.updated", event_id: "evt_usage_001",
    usage: { seconds },
  }, sessionId) as Extract<SidebandObservation, {type:"usage"}>;
}
function closure(sessionId: string, seconds: number, reason = "remote_hangup") {
  return parseBoundLiveSidebandEvent({
    type: "session.closed", event_id: "evt_closed_001",
    reason, usage: { seconds }, session: { id: sessionId },
  }, sessionId) as Extract<SidebandObservation, {type:"closed"}>;
}

test("usage updates are cumulative and bound to their sideband session", () => {
  assert.deepEqual(observation(liveId(1), 12.5), {
    type:"usage", eventId:"evt_usage_001", sessionId:liveId(1), seconds:12.5,
  });
  assert.equal(parseBoundLiveSidebandEvent({ type:"response.event" }, liveId(1)), null);
  assert.throws(() => parseBoundLiveSidebandEvent({
    type:"session.closed", event_id:"evt_closed_001", reason:"remote_hangup",
    usage:{seconds:12}, session:{id:liveId(2)},
  }, liveId(1)), error("SIDEBAND_SESSION_MISMATCH"));
});

test("unknown close reason, malformed duration and event ID fail closed", () => {
  assert.throws(() => closure(liveId(2), -1), error("INVALID_USAGE"));
  assert.throws(() => closure(liveId(2), Number.POSITIVE_INFINITY), error("INVALID_USAGE"));
  assert.throws(() => closure(liveId(2), 20, "unknown_reason"), error("INVALID_CLOSE_REASON"));
  assert.throws(() => parseBoundLiveSidebandEvent({
    type:"session.usage.updated", event_id:"", usage:{seconds:1},
  }, liveId(2)), error("INVALID_EVENT_ID"));
});

test("observed usage is monotonic, never additive on duplicate events", async () => {
  await reset(); await createCall(3);
  await noteLiveUsage(db, observation(liveId(3), 45.5));
  await noteLiveUsage(db, observation(liveId(3), 12));
  await noteLiveUsage(db, observation(liveId(3), 45.5));
  let row=await db.salesVoiceCall.findUniqueOrThrow({where:{providerCallId:liveId(3)}});
  assert.equal(row.lastUsageSeconds,45.5);
  await noteLiveUsage(db, observation(liveId(3), 61.25));
  row=await db.salesVoiceCall.findUniqueOrThrow({where:{providerCallId:liveId(3)}});
  assert.equal(row.lastUsageSeconds,61.25);
  assert.ok(row.usageObservedAt);
});

test("unverified/non-Live call cannot receive sideband usage or finalization", async () => {
  await reset();
  await db.salesVoiceCall.create({data:{
    provider:"TWILIO",providerCallId:liveId(4),status:"ACCEPTED",
  }});
  await assert.rejects(noteLiveUsage(db,observation(liveId(4),10)),error("VERIFIED_LIVE_CALL_REQUIRED"));
  await assert.rejects(finalizeLiveClosed(db,closure(liveId(4),10)),error("VERIFIED_LIVE_CALL_REQUIRED"));
});

test("session.closed is authoritative for release and final usage", async () => {
  await reset(); await createCall(5,"HANGUP_SENT");
  await noteLiveUsage(db,observation(liveId(5),122.5));
  const final=await finalizeLiveClosed(db,closure(liveId(5),125.25));
  assert.equal(final.status,"COMPLETED");
  assert.equal(final.finalUsageSeconds,125.25);
  assert.equal(final.lastUsageSeconds,125.25);
  assert.equal(final.closeReason,"remote_hangup");
  assert.ok(final.finalizedAt);
  assert.ok(final.endedAt);
  assert.ok(final.durationSeconds !== null && final.durationSeconds >= 0);
});

test("replayed close cannot double finalize or overwrite another outcome", async () => {
  await reset(); await createCall(6);
  const first=await finalizeLiveClosed(db,closure(liveId(6),72.5));
  const replay=await finalizeLiveClosed(db,closure(liveId(6),72.5));
  assert.deepEqual(replay.finalizedAt,first.finalizedAt);
  await assert.rejects(finalizeLiveClosed(db,closure(liveId(6),99)),error("CONFLICTING_FINAL_EVENT"));
  const later=await noteLiveUsage(db,observation(liveId(6),300));
  assert.equal(later.finalUsageSeconds,72.5);
});

test("regressive final usage does not release capacity on contradictory evidence", async () => {
  await reset(); await createCall(7);
  await noteLiveUsage(db,observation(liveId(7),90));
  await assert.rejects(finalizeLiveClosed(db,closure(liveId(7),89)),error("FINAL_USAGE_BELOW_OBSERVED"));
  const row=await db.salesVoiceCall.findUniqueOrThrow({where:{providerCallId:liveId(7)}});
  assert.equal(row.status,"ACCEPTED");
  assert.equal(row.finalizedAt,null);
});

test("watchdog fails closed when disabled, invalid or provider key missing", async () => {
  await reset(); await createCall(8);
  const transport: HangupHTTP=async()=>({status:200});
  await assert.rejects(watchdog.runOnce({policy:config({enabled:false}),apiKey:"sk-mock",transport}),error("WATCHDOG_DISABLED"));
  await assert.rejects(watchdog.runOnce({policy:config({maxCallSeconds:0}),apiKey:"sk-mock",transport}),error("INVALID_WATCHDOG_POLICY"));
  await assert.rejects(watchdog.runOnce({policy:config(),apiKey:"bad",transport}),error("API_KEY_REQUIRED"));
  assert.equal((await db.salesVoiceCall.findUniqueOrThrow({where:{providerCallId:liveId(8)}})).status,"ACCEPTED");
});

test("hangup client uses exactly one POST with no body and no retries", async () => {
  let hits=0;
  const transport: HangupHTTP=async (url,req)=>{
    hits++;
    assert.equal(url,"https://api.openai.com/v1/live/sessions/"+liveId(9)+"/hangup");
    assert.equal(req.method,"POST");
    assert.equal(req.headers.Authorization,"Bearer sk-test");
    assert.equal("body" in req,false);
    return {status:200};
  };
  await postOneLiveHangup({sessionId:liveId(9),apiKey:"sk-test",enabled:true,transport});
  assert.equal(hits,1);
  await assert.rejects(postOneLiveHangup({sessionId:liveId(9),apiKey:"sk-test",enabled:false,transport}),error("HANGUP_DISABLED"));
  assert.equal(hits,1);
});

test("watchdog only selects overdue accepted calls; request acknowledgement still holds slot", async () => {
  await reset(); await createCall(10,"ACCEPTED",100); await createCall(11,"ACCEPTED",450);
  let requests=0;
  const transport: HangupHTTP=async()=>{requests++;return {status:200};};
  const result=await watchdog.runOnce({policy:config(),apiKey:"sk-test",transport});
  assert.deepEqual(result,{inspected:1,claimed:1,sent:1,unknown:0});
  assert.equal(requests,1);
  const due=await db.salesVoiceCall.findUniqueOrThrow({where:{providerCallId:liveId(11)}});
  assert.equal(due.status,"HANGUP_SENT");
  assert.ok(due.hangupClaimedAt && due.hangupAcknowledgedAt);
  assert.equal(due.finalizedAt,null);
  assert.equal((await db.salesVoiceCall.findUniqueOrThrow({where:{providerCallId:liveId(10)}})).status,"ACCEPTED");
  await createCall(12,"RECEIVED",10);
  await assert.rejects(admission.claim(liveId(12),capacity()), e =>
    typeof e === "object" && e !== null && "code" in e && e.code === "CONCURRENCY_LIMIT");
});

test("overdue unknown-accept can receive exactly one precautionary hangup", async () => {
  await reset(); await createCall(13,"ACCEPT_UNKNOWN",800);
  let requests=0;
  const transport: HangupHTTP=async()=>{requests++;return {status:200};};
  const r=await watchdog.runOnce({policy:config(),apiKey:"sk-test",transport});
  assert.equal(r.sent,1);
  assert.equal(requests,1);
  const row=await db.salesVoiceCall.findUniqueOrThrow({where:{providerCallId:liveId(13)}});
  assert.equal(row.status,"HANGUP_SENT");
});

test("two concurrent watchdog cycles can initiate only one provider hangup", async () => {
  await reset(); await createCall(14);
  let requests=0;
  const transport: HangupHTTP=async()=>{requests++; await new Promise(r=>setTimeout(r,20)); return {status:200};};
  const [a,b]=await Promise.all([
    watchdog.runOnce({policy:config(),apiKey:"sk-test",transport}),
    watchdog.runOnce({policy:config(),apiKey:"sk-test",transport}),
  ]);
  assert.equal(a.sent+b.sent,1);
  assert.equal(a.claimed+b.claimed,1);
  assert.equal(requests,1);
});

test("transport ambiguity retains HANGUP_UNKNOWN, blocks retries and still consumes capacity", async () => {
  await reset(); await createCall(15);
  let requests=0;
  const transport: HangupHTTP=async()=>{requests++;throw Error("timeout");};
  const once=await watchdog.runOnce({policy:config(),apiKey:"sk-test",transport});
  const twice=await watchdog.runOnce({policy:config(),apiKey:"sk-test",transport});
  assert.deepEqual(once,{inspected:1,claimed:1,sent:0,unknown:1});
  assert.equal(twice.claimed,0);
  assert.equal(requests,1);
  const row=await db.salesVoiceCall.findUniqueOrThrow({where:{providerCallId:liveId(15)}});
  assert.equal(row.status,"HANGUP_UNKNOWN");
  await createCall(16,"RECEIVED",10);
  await assert.rejects(admission.claim(liveId(16),capacity()),e=>
    typeof e==="object" && e!==null && "code" in e && e.code==="CONCURRENCY_LIMIT");
});

test("valid session.closed releases held capacity after ambiguous hangup", async () => {
  await reset(); await createCall(17,"HANGUP_UNKNOWN");
  await finalizeLiveClosed(db,closure(liveId(17),230,"close_requested"));
  const row=await db.salesVoiceCall.findUniqueOrThrow({where:{providerCallId:liveId(17)}});
  assert.equal(row.status,"COMPLETED");
  assert.equal(row.closeReason,"close_requested");
  await createCall(18,"RECEIVED",10);
  const allowed=await admission.claim(liveId(18),capacity());
  assert.equal(allowed.result,"CLAIMED");
});

test("session.closed may arrive during in-flight hangup and wins over acknowledgement", async () => {
  await reset(); await createCall(19,"ACCEPTED",500);
  const transport: HangupHTTP=async()=>{
    await finalizeLiveClosed(db,closure(liveId(19),130,"close_requested"));
    return {status:200};
  };
  const result=await watchdog.runOnce({policy:config(),apiKey:"sk-test",transport});
  assert.equal(result.sent,1);
  const row=await db.salesVoiceCall.findUniqueOrThrow({where:{providerCallId:liveId(19)}});
  assert.equal(row.status,"COMPLETED");
  assert.ok(row.finalizedAt);
});

test("usage beyond reserved duration increases estimate for later admissions", async () => {
  await reset();
  await createCall(20,"ACCEPTED",100);
  await noteLiveUsage(db,observation(liveId(20),900));
  await createCall(21,"RECEIVED",10);
  await assert.rejects(admission.claim(liveId(21),capacity({
    maxConcurrentCalls:2,monthlyBudgetCents:200,estimatedCentsPerMinute:20,
  })), e=> typeof e==="object" && e!==null && "code" in e
    && e.code==="ESTIMATED_MONTHLY_BUDGET_LIMIT");
});

test("late usage racing with finalization cannot release an undercounted call", async () => {
  await reset(); await createCall(22);
  await noteLiveUsage(db,observation(liveId(22),20));
  // Deterministically simulate usage arriving after the initial read but
  // before the final UPDATE; the SQL predicate must fence the race.
  const injectedDb = { salesVoiceCall: {
    findUnique: (arg: any) => db.salesVoiceCall.findUnique(arg),
    findUniqueOrThrow: (arg: any) => db.salesVoiceCall.findUniqueOrThrow(arg),
    updateMany: async (arg: any) => {
      await db.salesVoiceCall.update({
        where: { providerCallId: liveId(22) },
        data: { lastUsageSeconds: 200 },
      });
      return db.salesVoiceCall.updateMany(arg);
    },
  } } as any;
  await assert.rejects(
    finalizeLiveClosed(injectedDb,closure(liveId(22),100)),
    error("FINAL_USAGE_BELOW_OBSERVED"),
  );
  const stored=await db.salesVoiceCall.findUniqueOrThrow({where:{providerCallId:liveId(22)}});
  assert.equal(stored.status,"ACCEPTED");
  assert.equal(stored.lastUsageSeconds,200);
  assert.equal(stored.finalizedAt,null);
});
