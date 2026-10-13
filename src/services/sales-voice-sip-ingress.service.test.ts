import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createServer } from "node:http";
import express from "express";
import { PrismaClient } from "@prisma/client";
import {
  buildIsolatedSalesSipIngressRouter,
  parseVerifiedOpenAISipEvent,
  recordVerifiedSipInvite,
  SalesSipIngressError,
} from "./sales-voice-sip-ingress.service.js";

const dbUrl = process.env.SALES_SIP_TEST_DATABASE_URL;
assert.ok(dbUrl);
const target = new URL(dbUrl);
assert.equal(target.protocol, "postgresql:");
assert.ok(["127.0.0.1", "localhost"].includes(target.hostname));
assert.equal(target.pathname, "/pingo_sales_sip_test");
assert.equal(process.env.DATABASE_URL, dbUrl);
const db = new PrismaClient({ datasources: { db: { url: dbUrl } } });
after(async () => db.$disconnect());

const callId = "rtc_u1_fixture_test";
const event = (id = callId) => ({
  object: "event",
  id: "evt_test_valid_identifier_000000001",
  type: "realtime.call.incoming",
  data: {
    call_id: id,
    sip_headers: [
      { name: "From", value: "sip:+17875550100@example.net" },
      { name: "To", value: "sip:proj_mock_openai_project@sip.api.openai.com" },
      { name: "Call-ID", value: "untrusted-sip-uuid@example.org" },
    ],
  },
});

function assertCode(fn: () => unknown, code: string) {
  assert.throws(fn, e => e instanceof SalesSipIngressError && e.code === code);
}

test("OpenAI call_id and SIP Call-ID remain distinct, and project To is not a phone number", () => {
  const parsed = parseVerifiedOpenAISipEvent(event())!;
  assert.equal(parsed.callId, callId);
  assert.equal(parsed.sipCallIdHint, "untrusted-sip-uuid@example.org");
  assert.equal(parsed.toPhoneHint, null);
  assert.equal(parsed.fromPhoneHint, "+17875550100");
});

test("unrelated OpenAI webhook never becomes a call", () => {
  assert.equal(parseVerifiedOpenAISipEvent({ type: "response.completed" }), null);
});

test("reject malformed SIP events before persistence", () => {
  assertCode(() => parseVerifiedOpenAISipEvent({ ...event(), data: {call_id:"wrong id!", sip_headers:[]} }), "INVALID_CALL_ID");
  assertCode(() => parseVerifiedOpenAISipEvent({ ...event(), data:{ call_id:callId, sip_headers:[{name:"From",value:5}]} }),"INVALID_HEADERS");
  assertCode(() => parseVerifiedOpenAISipEvent({ ...event(), id:"evt_" }), "INVALID_EVENT_ID");
});

test("OpenAI SIP call metadata persists without creating or matching a prospect", async () => {
  const before = await db.salesProspect.count();
  const result = await recordVerifiedSipInvite(db, parseVerifiedOpenAISipEvent(event())!);
  assert.equal(result.duplicate, false);
  assert.equal(result.call.provider, "OPENAI_SIP");
  assert.equal(result.call.providerCallId, callId);
  assert.equal(result.call.prospectId, null);
  assert.equal(await db.salesProspect.count(), before);
});

test("concurrent repeats create exactly one OpenAI SIP call record", async () => {
  const invite=parseVerifiedOpenAISipEvent(event("rtc_u1_concurrent_fixture"))!;
  const all=await Promise.all(Array.from({length:8},()=>recordVerifiedSipInvite(db,invite)));
  assert.equal(new Set(all.map(x=>x.call.id)).size,1);
  assert.equal(all.filter(x=>x.duplicate===false).length,1);
  assert.equal(await db.salesVoiceCall.count({where:{providerCallId:invite.callId}}),1);
});

test("same call ID with changed caller hint is rejected, not silently reattributed", async () => {
  const invite=parseVerifiedOpenAISipEvent(event("rtc_u1_collision_fixture"))!;
  await recordVerifiedSipInvite(db,invite);
  await assert.rejects(
    recordVerifiedSipInvite(db,{...invite,fromPhoneHint:"+12025550123"}),
    e=>e instanceof SalesSipIngressError && e.code==="CALL_ID_COLLISION"
  );
});

test("no dependency can be omitted", () => {
  assertCode(() => buildIsolatedSalesSipIngressRouter({} as any),"MISSING_SECURE_DEPENDENCY");
});

async function requestRouter(input: {
  enabled?: boolean;
  signature?: string | null;
  payload?: unknown;
  failSignature?: boolean;
  failPersist?: boolean;
}) {
  const app=express();
  let verifications=0, writes=0, rawWasString=false;
  app.use(buildIsolatedSalesSipIngressRouter({
    enabled:()=>input.enabled??true,
    verifySignedWebhook:async(raw,headers)=>{
      verifications++;
      rawWasString=typeof raw==="string" && raw.startsWith("{");
      if(input.failSignature || headers["webhook-signature"]!=="mock-valid") throw Error("mock verifier rejection");
      return JSON.parse(raw);
    },
    persistVerifiedInvite:async()=>{
      writes++;
      if(input.failPersist) throw Error("fixture db error");
    },
  }));
  const http=createServer(app);
  await new Promise<void>(resolve=>http.listen(0,"127.0.0.1",resolve));
  const address=http.address();
  assert.ok(address && typeof address!=="string");
  try {
    const headers: Record<string,string>={"Content-Type":"application/json"};
    if(input.signature!==null){
      headers["webhook-id"]="wh_test_event";
      headers["webhook-timestamp"]="1760328000";
      headers["webhook-signature"]=input.signature??"mock-valid";
    }
    const response=await fetch("http://127.0.0.1:"+address.port+"/webhooks/openai/sales-voice",{
      method:"POST",headers,body:JSON.stringify(input.payload??event()),
    });
    return {status:response.status,verifications,writes,rawWasString};
  } finally {
    await new Promise<void>((resolve,reject)=>http.close(e=>e?reject(e):resolve()));
  }
}

test("off-by-default gate returns 404 before attempting signature verification or storage", async () => {
  const r=await requestRouter({enabled:false});
  assert.equal(r.status,404);
  assert.equal(r.verifications,0);
  assert.equal(r.writes,0);
});

test("missing webhook signature fails closed", async () => {
  const r=await requestRouter({signature:null});
  assert.equal(r.status,401);
  assert.equal(r.verifications,0);
  assert.equal(r.writes,0);
});

test("invalid signature does not store a call", async () => {
  const r=await requestRouter({failSignature:true});
  assert.equal(r.status,401);
  assert.equal(r.writes,0);
});

test("verified webhook receives original body and accepts metadata only", async () => {
  const r=await requestRouter({});
  assert.equal(r.status,202);
  assert.equal(r.rawWasString,true);
  assert.equal(r.verifications,1);
  assert.equal(r.writes,1);
});

test("valid signature with malformed call data gets 400", async () => {
  const r=await requestRouter({payload:{...event(),data:{call_id:27,sip_headers:[]}}});
  assert.equal(r.status,400);
  assert.equal(r.writes,0);
});

test("other event types return 204 with no persistence", async () => {
  const r=await requestRouter({payload:{type:"response.completed",id:"evt_test_other"}});
  assert.equal(r.status,204);
  assert.equal(r.writes,0);
});

test("storage failure produces retryable 503, not false acknowledgement", async () => {
  const r=await requestRouter({failPersist:true});
  assert.equal(r.status,503);
  assert.equal(r.writes,1);
});
