import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import { after, test } from "node:test";
import express from "express";
import { PrismaClient } from "@prisma/client";
import { mountSalesVoiceLiveSipWebhook } from "./sales-voice-live-sip-mount.service.js";

const url = process.env.SALES_VOICE_ADMISSION_TEST_DATABASE_URL;
assert.ok(url, "Disposable admissions database is required");
const target = new URL(url);
assert.equal(target.protocol, "postgresql:");
assert.ok(["localhost", "127.0.0.1"].includes(target.hostname));
assert.equal(target.pathname, "/pingo_sales_admission_test");
assert.equal(process.env.DATABASE_URL, url);

const db = new PrismaClient({datasources:{db:{url}}});
after(async () => db.$disconnect());

const signingKey = Buffer.from("test-key-signed-ingress-claims-2026!");
const secret = "whsec_" + signingKey.toString("base64");
const webhookEnv = {
  SALES_VOICE_LIVE_WEBHOOK_ENABLED: "true",
  SALES_VOICE_WEBHOOK_RELEASE_CERTIFIED: "true",
  SALES_VOICE_OPENAI_WEBHOOK_SECRET: secret,
};
const simulationEnv = {
  ...webhookEnv,
  NODE_ENV: "test",
  RAILWAY_ENVIRONMENT_NAME: "sales-voice-certification",
  SALES_VOICE_ADMISSION_SIMULATION_ENABLED: "true",
  SALES_VOICE_ADMISSION_SIMULATION_RELEASE_CERTIFIED: "true",
  SALES_VOICE_MAX_CONCURRENT_CALLS: "1",
  SALES_VOICE_MONTHLY_BUDGET_CENTS: "300",
  SALES_VOICE_ESTIMATED_CENTS_PER_MINUTE: "10",
  SALES_VOICE_RESERVED_SECONDS_PER_CALL: "120",
};
const prefix = "live_ingress_bridge_";
let counter = 1;
async function reset() {
  await db.salesVoiceCall.deleteMany({
    where: { provider: "OPENAI_LIVE_SIP" },
  });
}
const nextId = () => prefix + counter++;
function event(sessionId: string, type = "live.transport.incoming") {
  return {
    object: "event", id: "evt_sales_ingress_fixture_12345678",
    type,
    data: { type: "sip", session_id: sessionId, sip_headers: [] },
  };
}

async function inServer(
  env: Record<string,string|undefined>,
  run: (send: (id: string, opts?: {unsigned?: boolean;type?: string}) => Promise<number>) => Promise<void>
): Promise<void> {
  const app = express();
  mountSalesVoiceLiveSipWebhook(app, db, env);
  app.use(express.json());
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1",resolve));
  const addr = server.address();
  assert.ok(addr && typeof addr !== "string");
  const send = async (id: string, opts: {unsigned?: boolean;type?: string} = {}) => {
    const body = JSON.stringify(event(id,opts.type));
    const stamp = String(Math.floor(Date.now()/1000));
    const eventId = "wh_ingress_fixture_123";
    const signature = createHmac("sha256",signingKey)
      .update(eventId+"."+stamp+"."+body).digest("base64");
    const response = await fetch(
      "http://127.0.0.1:"+addr.port+"/webhooks/openai/sales-live-voice", {
      method:"POST",
      headers:{
        "content-type":"application/json",
        "webhook-id":eventId,
        "webhook-timestamp":stamp,
        "webhook-signature":opts.unsigned?"v1,AAAA":"v1,"+signature,
      },
      body,
    });
    return response.status;
  };
  try { await run(send); }
  finally { await new Promise<void>((resolve,reject)=>server.close(err=>err?reject(err):resolve())); }
}

async function status(id:string) {
  return db.salesVoiceCall.findUnique({where:{providerCallId:id}});
}

test("production with signed webhook only: metadata recorded, no admission claim", async()=>{
  await reset();const id=nextId();
  await inServer({...simulationEnv, NODE_ENV:"production"},async send=>{
    assert.equal(await send(id),503,"Two simulation flags can never bypass production veto");
  });
  assert.equal(await status(id),null);
  const metadataId=nextId();
  await inServer({...webhookEnv,NODE_ENV:"production"},async send=>{
    assert.equal(await send(metadataId),202);
  });
  assert.equal((await status(metadataId))?.status,"RECEIVED");
});

test("metadata-only persists without either simulation gate even outside production", async()=>{
  await reset();const id=nextId();
  await inServer({...simulationEnv,SALES_VOICE_ADMISSION_SIMULATION_RELEASE_CERTIFIED:"false"},async send=>{
    assert.equal(await send(id),202);
  });
  assert.equal((await status(id))?.status,"RECEIVED");
});

test("invalid or missing limits fail before persisting any signed invitation",async()=>{
  await reset();const id=nextId();
  await inServer({...simulationEnv,SALES_VOICE_MAX_CONCURRENT_CALLS:"11"},async send=>{
    assert.equal(await send(id),503);
  });
  assert.equal(await status(id),null);
});

test("signed Live SIP invite reserves one Postgres admission slot in test only", async()=>{
  await reset();const id=nextId();
  await inServer(simulationEnv,async send=>{
    assert.equal(await send(id),202);
  });
  const row=await status(id);
  assert.equal(row?.provider,"OPENAI_LIVE_SIP");
  assert.equal(row?.direction,"INBOUND");
  assert.equal(row?.status,"ADMISSION_CLAIMED");
  assert.equal(row?.answeredAt,null);
  assert.equal(row?.lastUsageSeconds,null);
});

test("simultaneous signed duplicate deliveries never claim or store two calls",async()=>{
  await reset();const id=nextId();
  await inServer(simulationEnv,async send=>{
    const responses=await Promise.all(Array.from({length:8},()=>send(id)));
    assert.deepEqual(responses,[202,202,202,202,202,202,202,202]);
  });
  const calls=await db.salesVoiceCall.findMany({where:{providerCallId:id}});
  assert.equal(calls.length,1);
  assert.equal(calls[0].status,"ADMISSION_CLAIMED");
});

test("capacity check rejects a second session; no second accept or claim",async()=>{
  await reset();const a=nextId(), b=nextId();
  await inServer(simulationEnv,async send=>{
    assert.equal(await send(a),202);
    assert.equal(await send(b),503);
  });
  assert.equal((await status(a))?.status,"ADMISSION_CLAIMED");
  assert.equal((await status(b))?.status,"RECEIVED");
});

test("simulated estimated monthly budget blocks admissions without answering",async()=>{
  await reset();const id=nextId();
  await inServer({...simulationEnv,SALES_VOICE_MONTHLY_BUDGET_CENTS:"10"},async send=>{
    assert.equal(await send(id),503);
  });
  assert.equal((await status(id))?.status,"RECEIVED");
});

test("invalid signature or signed Realtime event cannot enter admission",async()=>{
  await reset();const a=nextId(), b=nextId();
  await inServer(simulationEnv,async send=>{
    assert.equal(await send(a,{unsigned:true}),401);
    assert.equal(await send(b,{type:"realtime.call.incoming"}),204);
  });
  assert.equal(await status(a),null);
  assert.equal(await status(b),null);
});

test("turning simulation off preserves incoming metadata only and never releases earlier claimed capacity",async()=>{
  await reset();const a=nextId(), b=nextId();
  await inServer(simulationEnv,async send=>{
    assert.equal(await send(a),202);
  });
  await inServer({...webhookEnv,NODE_ENV:"production"},async send=>{
    assert.equal(await send(b),202);
  });
  assert.equal((await status(a))?.status,"ADMISSION_CLAIMED");
  assert.equal((await status(b))?.status,"RECEIVED");
});
