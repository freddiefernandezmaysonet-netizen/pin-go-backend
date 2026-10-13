import assert from "node:assert/strict";
import { after, test } from "node:test";
import { PrismaClient } from "@prisma/client";
import {
  SalesVoiceAdmissionError, SalesVoiceLiveAdmission, postOneOpenAILiveAccept,
  attemptOneLiveAccept, salesVoiceStartupConfig,
  type AdmissionLimits, type ProviderHTTP,
} from "./sales-voice-live-admission.service.js";

const url = process.env.SALES_VOICE_ADMISSION_TEST_DATABASE_URL;
assert.ok(url, "Never run this suite without a dedicated disposable DB");
const parsed = new URL(url);
assert.equal(parsed.protocol, "postgresql:");
assert.ok(["localhost", "127.0.0.1"].includes(parsed.hostname));
assert.equal(parsed.pathname, "/pingo_sales_admission_test");
assert.equal(process.env.DATABASE_URL, url);
const db = new PrismaClient({ datasources: { db: { url } } });
const service = new SalesVoiceLiveAdmission(db);
after(async () => db.$disconnect());

const policy = (override: Partial<AdmissionLimits> = {}): AdmissionLimits => ({
  enabled: true, maxConcurrentCalls: 2, monthlyBudgetCents: 10000,
  estimatedCentsPerMinute: 20, reservedSecondsPerCall: 300, ...override,
});
const id = (num: number) => "live_test_admission_" + num;
async function reset() {
  await db.salesVoiceCall.deleteMany({ where: { provider: { in: ["OPENAI_LIVE_SIP", "TWILIO"] } } });
}
async function incoming(num: number, overrides: Record<string, unknown> = {}) {
  return db.salesVoiceCall.create({
    data: {
      provider: "OPENAI_LIVE_SIP", providerCallId: id(num), direction: "INBOUND",
      status: "RECEIVED", ...overrides,
    },
  });
}
const err = (code: string) => (e: unknown) =>
  e instanceof SalesVoiceAdmissionError && e.code === code;

test("disabled is fail closed before any DB admission claim", async () => {
  await reset();
  await incoming(1);
  await assert.rejects(service.claim(id(1),policy({enabled:false})),err("DISABLED"));
  assert.equal((await db.salesVoiceCall.findUniqueOrThrow({where:{providerCallId:id(1)}})).status,"RECEIVED");
});

test("cannot claim nonexistent, Twilio or completed call, even with a valid Live ID", async () => {
  await reset();
  await assert.rejects(service.claim(id(2),policy()),err("VERIFIED_LIVE_CALL_REQUIRED"));
  await incoming(2,{provider:"TWILIO"});
  await assert.rejects(service.claim(id(2),policy()),err("VERIFIED_LIVE_CALL_REQUIRED"));
  await db.salesVoiceCall.update({where:{providerCallId:id(2)},data:{provider:"OPENAI_LIVE_SIP",status:"COMPLETED"}});
  await assert.rejects(service.claim(id(2),policy()),err("NOT_ADMISSIBLE_STATUS"));
});

test("reject invalid configuration and untrusted session IDs", async () => {
  await reset();
  await assert.rejects(service.claim("rtc_other_system",policy()),err("INVALID_SESSION_ID"));
  await incoming(3);
  await assert.rejects(service.claim(id(3),policy({maxConcurrentCalls:0})),err("INVALID_LIMITS"));
  await assert.rejects(service.claim(id(3),policy({reservedSecondsPerCall:0})),err("INVALID_LIMITS"));
});

test("single verified Live call is claimed and repeated event does not claim twice", async () => {
  await reset();
  await incoming(4);
  const first=await service.claim(id(4),policy());
  const next=await service.claim(id(4),policy());
  assert.equal(first.result,"CLAIMED");
  assert.equal(next.result,"ALREADY_CLAIMED");
  assert.equal(next.call.id,first.call.id);
  assert.equal(next.call.status,"ADMISSION_CLAIMED");
});

test("global PostgreSQL advisory lock prevents concurrent workers from overbooking", async () => {
  await reset();
  await incoming(5); await incoming(6); await incoming(7);
  const results = await Promise.allSettled([5,6,7].map(i=>service.claim(id(i),policy())));
  assert.equal(results.filter(r=>r.status==="fulfilled").length,2);
  assert.equal(results.filter(r=>r.status==="rejected").length,1);
  const rejected=results.find(r=>r.status==="rejected") as PromiseRejectedResult;
  assert.ok(err("CONCURRENCY_LIMIT")(rejected.reason));
  const active=await db.salesVoiceCall.count({where:{status:"ADMISSION_CLAIMED",provider:"OPENAI_LIVE_SIP"}});
  assert.equal(active,2);
});

test("ambiguous prior accept consumes a slot until a separate reconciliation", async () => {
  await reset(); await incoming(8); await incoming(9);
  await service.claim(id(8),policy({maxConcurrentCalls:1}));
  await service.recordProviderOutcome(id(8),false);
  await assert.rejects(service.claim(id(9),policy({maxConcurrentCalls:1})),err("CONCURRENCY_LIMIT"));
  assert.equal((await db.salesVoiceCall.findUniqueOrThrow({where:{providerCallId:id(8)}})).status,"ACCEPT_UNKNOWN");
});

test("estimated budget reserves the next call before external network activity", async () => {
  await reset(); await incoming(10); await incoming(11);
  const cheap=policy({maxConcurrentCalls:3,monthlyBudgetCents:100,estimatedCentsPerMinute:20,reservedSecondsPerCall:300});
  await service.claim(id(10),cheap);
  await assert.rejects(service.claim(id(11),cheap),err("ESTIMATED_MONTHLY_BUDGET_LIMIT"));
  assert.equal((await db.salesVoiceCall.findUniqueOrThrow({where:{providerCallId:id(11)}})).status,"RECEIVED");
});

test("completed calls contribute measured duration to the monthly estimate", async () => {
  await reset();
  await incoming(12,{status:"COMPLETED",durationSeconds:240,startedAt:new Date()});
  await incoming(13);
  await assert.rejects(service.claim(id(13),policy({
    monthlyBudgetCents:160,estimatedCentsPerMinute:20,reservedSecondsPerCall:300,
  })),err("ESTIMATED_MONTHLY_BUDGET_LIMIT"));
});

test("verified accepted outcome recorded at most once and holds capacity", async () => {
  await reset(); await incoming(14);
  await service.claim(id(14),policy());
  const call=await service.recordProviderOutcome(id(14),true);
  assert.equal(call.status,"ACCEPTED");
  assert.ok(call.answeredAt);
  await assert.rejects(service.recordProviderOutcome(id(14),false),err("OUTCOME_ALREADY_RECORDED"));
});

test("startup config contains Live model, fixed voice, no audio format or tools", () => {
  const c=salesVoiceStartupConfig();
  assert.equal(c.session.type,"live");
  assert.equal(c.session.model,"gpt-live-1");
  assert.equal(c.session.audio.output.voice,"marin");
  const raw=JSON.stringify(c);
  assert.ok(raw.includes("inteligencia artificial"));
  assert.ok(!raw.includes('"format"'));
  assert.ok(!raw.includes('"tools"'));
  assert.ok(!raw.includes('"delegation"'));
});

test("network adapter uses documented URL, POST, valid bearer auth and no retry", async () => {
  let count=0;
  const transport: ProviderHTTP=async (url,options)=>{
    count++;
    assert.equal(url,"https://api.openai.com/v1/live/sessions/"+id(15)+"/accept");
    assert.equal(options.method,"POST");
    assert.equal(options.headers.Authorization,"Bearer sk-test-not-live");
    const request=JSON.parse(options.body);
    assert.equal(request.session.model,"gpt-live-1");
    assert.equal(request.session.type,"live");
    return {status:200};
  };
  await postOneOpenAILiveAccept({sessionId:id(15),apiKey:"sk-test-not-live",transport,explicitlyEnabled:true});
  assert.equal(count,1);
});

test("disabled provider transport, invalid credentials and non-200 cannot look successful", async () => {
  let count=0;
  const provider: ProviderHTTP=async()=>{count++;return {status:503};};
  await assert.rejects(postOneOpenAILiveAccept({sessionId:id(16),apiKey:"sk-test",transport:provider,explicitlyEnabled:false}),err("TRANSPORT_DISABLED"));
  await assert.rejects(postOneOpenAILiveAccept({sessionId:id(16),apiKey:"invalid",transport:provider,explicitlyEnabled:true}),err("API_KEY_REQUIRED"));
  await assert.rejects(postOneOpenAILiveAccept({sessionId:id(16),apiKey:"sk-test",transport:provider,explicitlyEnabled:true}),err("ACCEPT_NOT_CONFIRMED"));
  assert.equal(count,1);
});

test("one-shot accept only calls provider once under simultaneous requests", async () => {
  await reset(); await incoming(17);
  let requests=0;
  const transport: ProviderHTTP=async()=>{ requests++; await new Promise(r=>setTimeout(r,20)); return {status:200}; };
  const args={admission:service,sessionId:id(17),limits:policy(),apiKey:"sk-test",transport,explicitlyEnabled:true};
  const all=await Promise.all([attemptOneLiveAccept(args),attemptOneLiveAccept(args),attemptOneLiveAccept(args)]);
  assert.equal(all.filter(x=>x==="ACCEPTED").length,1);
  assert.equal(all.filter(x=>x==="ALREADY_CLAIMED").length,2);
  assert.equal(requests,1);
  assert.equal((await db.salesVoiceCall.findUniqueOrThrow({where:{providerCallId:id(17)}})).status,"ACCEPTED");
});

test("provider timeout is ambiguous: never retries or marks false success", async () => {
  await reset(); await incoming(18);
  let requests=0;
  const transport: ProviderHTTP=async()=>{requests++;throw Error("synthetic transport timeout");};
  const args={admission:service,sessionId:id(18),limits:policy(),apiKey:"sk-test",transport,explicitlyEnabled:true};
  assert.equal(await attemptOneLiveAccept(args),"ACCEPT_UNKNOWN");
  assert.equal(await attemptOneLiveAccept(args),"ALREADY_CLAIMED");
  assert.equal(requests,1);
  const row=await db.salesVoiceCall.findUniqueOrThrow({where:{providerCallId:id(18)}});
  assert.equal(row.status,"ACCEPT_UNKNOWN");
});
