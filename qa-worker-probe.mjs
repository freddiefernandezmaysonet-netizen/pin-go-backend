import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
const organizationId = "qa-worker-org";
const propertyId = "qa-worker-property";
const reservationId = "qa-worker-reservation";
const guestEmail = "worker@example.invalid";
const pilotPhone="+12025550101", legacyPhone="+12025550102";
const smsConsent={consent:{smsConsent:true,acceptedAt:new Date().toISOString()}};
const twilioEnv={TWILIO_ACCOUNT_SID:"AC"+"0".repeat(32),TWILIO_API_KEY:"SK"+"1".repeat(32),TWILIO_API_SECRET:"synthetic",TWILIO_FROM_NUMBER:"+12025550103",TWILIO_AUTH_TOKEN:"synthetic-token",PUBLIC_API_BASE_URL:"https://qa.invalid",MESSAGE_DELIVERY_WEBHOOKS_ENABLED:"1"};
const now = Date.now();
let child;
let api;
try {
  await db.organization.create({data: {id: organizationId, name: "Worker QA"}});
  await db.property.create({data: {id: propertyId, organizationId, name: "Worker QA", timezone: "America/Puerto_Rico", isTestProperty: true, address1: "Synthetic location"}});
  await db.reservation.create({data: {
    id: reservationId, propertyId, guestName: "QA", guestEmail,guestPhone:pilotPhone,externalRaw:smsConsent,
    status: "ACTIVE", paymentState: "PAID", source: "DIRECT_BOOKING",
    createdAt: new Date(now - 86400000), checkIn: new Date(now + 7200000), checkOut: new Date(now + 86400000),
    guestJourney: {create: {}}
  }});
  const legacyId = "qa-legacy-reservation";
  await db.reservation.create({data: {
    id: legacyId, propertyId, guestName: "Legacy QA", guestEmail:"legacy@example.invalid",guestPhone:legacyPhone,externalRaw:smsConsent,
    status:"ACTIVE", paymentState:"PAID", source:"DIRECT_BOOKING",
    createdAt:new Date(now-86400000),checkIn:new Date(now+7200000),checkOut:new Date(now+86400000),
    guestJourney:{create:{}}
  }});
  child = spawn(process.execPath, ["--import", "./qa-email-provider.mjs","--import","./qa-sms-provider.mjs", "--import", "tsx", "src/workers/reservation.worker.ts"], {
    env: {...process.env,...twilioEnv, RESEND_API_KEY:"synthetic", MESSAGE_DELIVERY_RESEND_ACCOUNT_KEY:"qa-resend", GUEST_JOURNEY_CANARY_EXECUTE: "1", MESSAGE_DELIVERY_ACCOUNT_BINDING_ENABLED: "1",
      GUEST_JOURNEY_CANARY_ORGANIZATION_ID: organizationId, GUEST_JOURNEY_CANARY_PROPERTY_ID: propertyId,
      GUEST_JOURNEY_CANARY_RESERVATION_ID: reservationId, GUEST_JOURNEY_CANARY_EMAIL: guestEmail,
      GUEST_JOURNEY_CANARY_SMS: pilotPhone, RESERVATION_WORKER_POLL_MS: "2000"},
    stdio: ["ignore", "pipe", "inherit"]
  });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; process.stdout.write(chunk); });
  for (let n = 0; n < 120 && (output.match(/processCheckouts result/g) || []).length < 3; n++) {
    assert.equal(child.exitCode, null);
    await delay(1000);
  }
  assert.ok((output.match(/processCheckouts result/g) || []).length >= 3, "three automatic cycles");
  const where = {reservationId};
  const messages = await db.messageLog.findMany({where, select: {channel:true, status:true, providerMessageId:true}});
  const ownership = await db.messageDispatchLog.findMany({where:{...where,type:"PRECHECKIN"},select:{channel:true,status:true}});
  const intents = await db.guestJourneyCoordinationIntent.findMany({where:{...where,reasonCode:"PRECHECKIN_CANARY_FIRST_SEND"},select:{status:true}});
  console.log("WORKER_RESULT", JSON.stringify({messages,ownership,intents}));
  assert.deepEqual(ownership.map(x=>x.channel+"/"+x.status).sort(),["email/E7_OWNED","sms/E7_OWNED"]);
  assert.equal(intents.length,2);
  const legacy = await db.messageLog.findMany({where:{reservationId:legacyId},select:{channel:true,status:true,providerMessageId:true}});
  const calls = (await (await import("node:fs/promises")).readFile("/tmp/qa-email-calls.jsonl","utf8")).trim().split("\n").map(JSON.parse);
  console.log("COEXISTENCE",JSON.stringify({legacy,calls}));
  assert.equal(await db.guestJourneyCoordinationIntent.count({where:{reservationId:legacyId,reasonCode:"PRECHECKIN_CANARY_FIRST_SEND"}}),0);
  assert.deepEqual(calls.flatMap(c=>c.to).sort(),[guestEmail,"legacy@example.invalid"].sort());
  for(const [rows,to] of [[legacy,"legacy@example.invalid"],[messages,guestEmail]]){
    assert.equal(rows.length,2);
    assert.equal(rows.find(r=>r.channel==="email").providerMessageId,calls.find(c=>[c.to].flat().includes(to)).id);
  }
  const key = Buffer.from("isolated-webhook-key");
  api = spawn(process.execPath,["--import","tsx","src/server.ts"],{stdio:"inherit",env:{
    ...process.env,...twilioEnv, PORT:"3081", NODE_ENV:"production", APP_URL:"https://qa.invalid",
    FRONTEND_ORIGIN:"https://qa.invalid", STRIPE_SECRET_KEY:"sk_test_synthetic", JWT_SECRET:"synthetic-test-only",
    MESSAGE_DELIVERY_WEBHOOKS_ENABLED:"1", MESSAGE_DELIVERY_RECEIPT_INBOX_MODE:"OFF",
    RESEND_WEBHOOK_SECRET:"whsec_"+key.toString("base64")
  }});
  for(let n=0;n<60;n++){
    if(await fetch("http://localhost:3081/ready").then(r=>r.ok).catch(()=>false)) break;
    assert.equal(api.exitCode,null);
    await delay(500);
  }
  for(const call of calls){
    const payload=JSON.stringify({type:"email.delivered",data:{email_id:call.id},created_at:new Date().toISOString()});
    const timestamp=String(Math.floor(Date.now()/1000));
    const signature=(await import("node:crypto")).createHmac("sha256",key).update([call.id,timestamp,payload].join(".")).digest("base64");
    const response=await fetch("http://localhost:3081/webhooks/delivery/resend",{method:"POST",body:payload,headers:{
      "Content-Type":"application/json","svix-id":call.id,"svix-timestamp":timestamp,"svix-signature":"v1,"+signature
    }});
    const result=await response.json();
    assert.equal(response.status,200,JSON.stringify(result));
    assert.equal(result.matched,true);
    const row=await db.messageLog.findFirstOrThrow({where:{providerMessageId:call.id}});
    assert.equal(row.providerDeliveryStatus,"DELIVERED");
    assert.equal(row.reservationId,[call.to].flat().includes(guestEmail)?reservationId:legacyId);
  }
  const smsCalls=(await (await import("node:fs/promises")).readFile("/tmp/qa-sms-calls.jsonl","utf8")).trim().split("\n").map(JSON.parse);
  assert.deepEqual(smsCalls.map(c=>c.to).sort(),[pilotPhone,legacyPhone].sort());
  const {default:twilio}=await import("twilio");
  for(const call of smsCalls){
    const params={MessageSid:call.sid,MessageStatus:"delivered",AccountSid:twilioEnv.TWILIO_ACCOUNT_SID};
    const signature=twilio.getExpectedTwilioSignature(twilioEnv.TWILIO_AUTH_TOKEN,"https://qa.invalid/webhooks/delivery/twilio",params);
    const response=await fetch("http://localhost:3081/webhooks/delivery/twilio",{method:"POST",body:new URLSearchParams(params),headers:{"x-twilio-signature":signature}});
    assert.equal(response.status,204,await response.text());
    const row=await db.messageLog.findFirstOrThrow({where:{providerMessageId:call.sid}});
    assert.equal(row.providerDeliveryStatus,"DELIVERED");
    assert.equal(row.reservationId,call.to===pilotPhone?reservationId:legacyId);
  }
  console.log("SMS coexistence verified: two sends, two correctly correlated signed receipts");
  console.log("Both simulated signed delivery receipts matched the correct reservation");
} finally {
  if(api && api.exitCode===null) api.kill("SIGTERM");
  if (child && child.exitCode === null) { const stopped = once(child,"exit"); child.kill("SIGTERM"); await stopped; }
  await db.$disconnect();
}