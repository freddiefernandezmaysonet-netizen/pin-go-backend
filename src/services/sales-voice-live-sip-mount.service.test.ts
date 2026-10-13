import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { test } from "node:test";
import express from "express";
import type { PrismaClient } from "@prisma/client";
import { mountSalesVoiceLiveSipWebhook } from "./sales-voice-live-sip-mount.service.js";

const fixtureSecret = "whsec_" + Buffer.from("independent-sales-voice-test-signing-key-2026").toString("base64");
const id = "live_sales_mount_fixture_1";
const body = {
  id: "evt_sales_mount_fixture_12345",
  object: "event",
  type: "live.transport.incoming",
  data: {
    type: "sip",
    session_id: id,
    sip_headers: [
      { name: "From", value: "sip:+17875551234@trunk.example.test" },
      { name: "To", value: "sip:+19395550111@trunk.example.test" },
    ],
  },
};
const enabledConfig = {
  SALES_VOICE_LIVE_WEBHOOK_ENABLED: "true",
  SALES_VOICE_WEBHOOK_RELEASE_CERTIFIED: "true",
  SALES_VOICE_OPENAI_WEBHOOK_SECRET: fixtureSecret,
};
type Call = { id: string; providerCallId: string; provider: string; direction: string; status: string };
function fixture() {
  const stored = new Map<string, Call>();
  let writes = 0;
  const db = {
    salesVoiceCall: {
      async create({ data }: { data: Call }) {
        writes++;
        if (stored.has(data.providerCallId)) {
          throw Object.assign(new Error("Duplicate call"), {code: "P2002"});
        }
        const record = {...data, id: "db_call_" + stored.size};
        stored.set(data.providerCallId, record);
        return record;
      },
      async findUnique({where}: {where: {providerCallId: string}}) {
        return stored.get(where.providerCallId) ?? null;
      },
    },
  } as unknown as Pick<PrismaClient, "salesVoiceCall">;
  return { db, stored, get writes() { return writes; } };
}
async function request(input: {
  env: Record<string,string|undefined>;
  payload?: unknown;
  corruptSignature?: boolean;
  overridePath?: string;
  rawText?: string;
  signedRawText?: string;
}) {
  const store = fixture();
  const app = express();
  // Replicate the backend registration order, so its first parser consumes
  // the raw signed JSON before a global express.json middleware can touch it.
  mountSalesVoiceLiveSipWebhook(app, store.db, input.env);
  app.use(express.json());
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    const raw = input.rawText ?? JSON.stringify(input.payload ?? body);
    const stamp = String(Math.floor(Date.now()/1000));
    const whid = "wh_sales_mount_123";
    const sig = createHmac("sha256", Buffer.from(fixtureSecret.slice(6), "base64"))
      .update(whid + "." + stamp + "." + (input.signedRawText ?? raw)).digest("base64");
    const res = await fetch(
      "http://127.0.0.1:" + address.port +
        (input.overridePath ?? "/webhooks/openai/sales-live-voice"), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "webhook-id": whid,
          "webhook-timestamp": stamp,
          "webhook-signature": input.corruptSignature ? "v1,AAAA" : "v1," + sig,
        },
        body: raw,
      },
    );
    return {status:res.status, records:[...store.stored.values()], writes:store.writes};
  } finally {
    await new Promise<void>((resolve,reject) => server.close(err=>err?reject(err):resolve()));
  }
}

test("no release flag -> 404, zero DB effects even with a signed event", async () => {
  assert.equal((await request({env:{}})).status,404);
  const r=await request({env:{SALES_VOICE_OPENAI_WEBHOOK_SECRET:fixtureSecret}});
  assert.deepEqual(r,{status:404,records:[],writes:0});
});
test("one flag alone is insufficient for activating the commercial webhook", async () => {
  for(const key of ["SALES_VOICE_LIVE_WEBHOOK_ENABLED","SALES_VOICE_WEBHOOK_RELEASE_CERTIFIED"]) {
    const r=await request({env:{[key]:"true",SALES_VOICE_OPENAI_WEBHOOK_SECRET:fixtureSecret}});
    assert.deepEqual(r,{status:404,records:[],writes:0});
  }
});
test("enabled without dedicated project signing secret fails closed", async () => {
  const {SALES_VOICE_OPENAI_WEBHOOK_SECRET:_secret,...env}=enabledConfig;
  const r=await request({env});
  assert.deepEqual(r,{status:401,records:[],writes:0});
});
test("enabled but forged signature never reaches DB", async () => {
  const r=await request({env:enabledConfig,corruptSignature:true});
  assert.deepEqual(r,{status:401,records:[],writes:0});
});
test("signed Live SIP event persists only untrusted metadata; never answers a call", async () => {
  const r=await request({env:enabledConfig});
  assert.equal(r.status,202);
  assert.equal(r.writes,1);
  assert.equal(r.records.length,1);
  assert.deepEqual(r.records[0],{
    id:"db_call_0",providerCallId:id,provider:"OPENAI_LIVE_SIP",
    direction:"INBOUND",status:"RECEIVED",
    fromPhoneE164:"+17875551234",toPhoneE164:"+19395550111",
  });
});
test("signed Realtime events and malformed signed Live invites cannot create calls", async () => {
  const realtime=await request({env:enabledConfig,payload:{...body,type:"realtime.call.incoming"}});
  assert.deepEqual(realtime,{status:204,records:[],writes:0});
  const malformed=await request({env:enabledConfig,payload:{...body,data:{type:"sip",session_id:"bad space",sip_headers:[]}}});
  assert.deepEqual(malformed,{status:400,records:[],writes:0});
});
test("raw byte tampering is rejected even with a previously valid signature", async () => {
  const original=JSON.stringify(body);
  const tampered=original+" ";
  const env=enabledConfig;
  // Signature was computed for the original, but the network body was changed.
  const r=await request({env,rawText:tampered,signedRawText:original});
  assert.deepEqual(r,{status:401,records:[],writes:0});
});
test("main server registers the signed route before the global JSON parser", () => {
  const source=readFileSync(new URL("../server.ts",import.meta.url),"utf8");
  const mount=source.indexOf("mountSalesVoiceLiveSipWebhook(app, prisma, process.env);");
  const json=source.indexOf("express.json({");
  const stripe=source.indexOf("registerStripeWebhook(app);");
  assert.ok(mount>stripe && mount<json,"Webhook mount must preserve raw signed bytes and Stripe route");
  assert.equal((source.match(/mountSalesVoiceLiveSipWebhook\(app, prisma, process.env\)/g)||[]).length,1);
  assert.equal(source.includes("SALES_VOICE_OPENAI_API_KEY"),false,"Existing API secret must not be used to sign webhooks");
});
