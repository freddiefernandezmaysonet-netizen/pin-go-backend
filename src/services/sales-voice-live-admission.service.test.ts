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
    assert.equal(request.session.input.length,1);
    const opening=request.session.input[0];
    assert.equal(opening.type,"message");
    assert.equal(opening.role,"developer");
    assert.equal(opening.content.length,1);
    assert.equal(opening.content[0].type,"input_text");
    assert.match(opening.content[0].text,/Saluda ahora en español e ingles, sin esperar/);
    assert.match(opening.content[0].text,/soy el asistente de inteligencia artificial de Pin&Go/);
    assert.match(opening.content[0].text,/Hello, I am Pin&Go.s AI assistant/);
    assert.match(opening.content[0].text,/¿Prefieres español o inglés\?/);
    assert.match(opening.content[0].text,/Would you prefer Spanish or English\?/);
    assert.match(opening.content[0].text,/pausa y escucha/);
    assert.ok(!request.session.instructions.includes("Habla en español hasta"));
    assert.match(request.session.instructions,/pide ingles, cambia inmediatamente a ingles/);
    assert.match(request.session.instructions,/manten ese idioma hasta que pida otro/);
    assert.match(request.session.instructions,/Pin&Go SI cuenta con Direct Booking o reservas directas/);
    assert.match(request.session.instructions,/propiedades publicadas/);
    assert.match(request.session.instructions,/Si preguntan si Pin&Go tiene Direct Booking, responde SI inmediatamente/);
    assert.match(request.session.instructions,/Nunca digas que vas a verificar, consultar, revisar, contactar a alguien o devolver una respuesta despues/);
    assert.match(request.session.instructions,/no tenga herramientas para consultar una propiedad concreta o crear una reserva/);
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
  const transport: ProviderHTTP=async(_url,options)=>{
    requests++;
    assert.equal(JSON.parse(options.body).session.input.filter((m:{role:string})=>m.role==="developer").length,1);
    await new Promise(r=>setTimeout(r,20)); return {status:200};
  };
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

function windowPolicy():AdmissionLimits {
  return policy({maxConcurrentCalls:1,reservedSecondsPerCall:120,
    certificationWindow:{startsAtMs:Date.now()-10000,endsAtMs:Date.now()+300000}});
}
test("certification quota persists across new admission instances and completed calls",async()=>{
  await reset();await incoming(101);const limits=windowPolicy();
  await service.claim(id(101),limits);
  await db.salesVoiceCall.update({where:{providerCallId:id(101)},data:{
    status:"COMPLETED",finalizedAt:new Date(),finalUsageSeconds:4,
  }});
  await incoming(102);
  const restarted=new SalesVoiceLiveAdmission(db);
  await assert.rejects(restarted.claim(id(102),limits),err("CERTIFICATION_ATTEMPT_LIMIT"));
  assert.equal((await db.salesVoiceCall.findUniqueOrThrow({where:{providerCallId:id(102)}})).status,"RECEIVED");
});
test("simultaneous distinct calls compete for one durable certification attempt",async()=>{
  await reset();await incoming(103);await incoming(104);const limits=windowPolicy();
  const results=await Promise.allSettled([103,104].map(n=>service.claim(id(n),limits)));
  assert.equal(results.filter(v=>v.status==="fulfilled").length,1);
  const failed=results.find(v=>v.status==="rejected") as PromiseRejectedResult;
  assert.ok(err("CERTIFICATION_ATTEMPT_LIMIT")(failed.reason));
});
test("unknown provider outcome consumes certification attempt without retry or release",async()=>{
  await reset();await incoming(105);await incoming(106);const limits=windowPolicy();let calls=0;
  assert.equal(await attemptOneLiveAccept({
    admission:service,sessionId:id(105),limits,apiKey:"sk-certification-fixture",
    transport:async()=>{calls++;throw Error("fixture timeout");},explicitlyEnabled:true,
  }),"ACCEPT_UNKNOWN");
  await assert.rejects(new SalesVoiceLiveAdmission(db).claim(id(106),limits),err("CERTIFICATION_ATTEMPT_LIMIT"));
  assert.equal(calls,1);
});
test("expired window uses database time and cannot be reopened by caller clock",async()=>{
  await reset();await incoming(107);
  const limits=windowPolicy();
  limits.certificationWindow={startsAtMs:Date.now()-300000,endsAtMs:Date.now()-1000};
  await assert.rejects(service.claim(id(107),limits,new Date(limits.certificationWindow.startsAtMs+1000)),
    err("CERTIFICATION_WINDOW_CLOSED"));
});
test("stale invite and insufficient drain reservation are denied before claiming",async()=>{
  await reset();const limits=windowPolicy();
  await incoming(108,{startedAt:new Date(limits.certificationWindow!.startsAtMs-1000)});
  await assert.rejects(service.claim(id(108),limits),err("CERTIFICATION_FRESH_INVITE_REQUIRED"));
  await incoming(109);
  const short={...limits,certificationWindow:{startsAtMs:Date.now()-10000,endsAtMs:Date.now()+60000}};
  await assert.rejects(service.claim(id(109),short),err("CERTIFICATION_WINDOW_CLOSED"));
});
test("invalid or enlarged certification window cannot bypass one-call policy",async()=>{
  await reset();await incoming(110);const limits=windowPolicy();
  for(const broken of [
    {...limits,maxConcurrentCalls:2},
    {...limits,reservedSecondsPerCall:361},
    {...limits,certificationWindow:{startsAtMs:NaN,endsAtMs:Date.now()+300000}},
    {...limits,certificationWindow:{startsAtMs:Date.now(),endsAtMs:Date.now()+3600000}},
  ])await assert.rejects(service.claim(id(110),broken),err("INVALID_CERTIFICATION_WINDOW"));
});
test("window expiry during admission transaction rolls back the claim",async()=>{
  await reset();await incoming(111);const limits=windowPolicy();let clocks=0;
  const guarded=new Proxy(db,{get(target,prop){
    const value=Reflect.get(target,prop,target);
    if(prop==="$transaction")return(callback:(tx:unknown)=>Promise<unknown>)=>value.call(target,
      (tx:object)=>callback(new Proxy(tx,{get(inner,key){
        const method=Reflect.get(inner,key,inner);
        if(key==="$queryRaw")return()=>Promise.resolve([{now:new Date(
          ++clocks===1?Date.now():limits.certificationWindow!.endsAtMs)}]);
        return typeof method==="function"?method.bind(inner):method;
      }})));
    return typeof value==="function"?value.bind(target):value;
  }});
  await assert.rejects(new SalesVoiceLiveAdmission(guarded).claim(id(111),limits),err("CERTIFICATION_WINDOW_CLOSED"));
  assert.equal((await db.salesVoiceCall.findUniqueOrThrow({where:{providerCallId:id(111)}})).status,"RECEIVED");
});

test("failed terminal status cannot refund a certification attempt",async()=>{
  await reset();await incoming(112);const limits=windowPolicy();
  await service.claim(id(112),limits);
  await db.salesVoiceCall.update({where:{providerCallId:id(112)},data:{status:"FAILED",endedAt:new Date()}});
  await incoming(113);
  await assert.rejects(new SalesVoiceLiveAdmission(db).claim(id(113),limits),err("CERTIFICATION_ATTEMPT_LIMIT"));
});
