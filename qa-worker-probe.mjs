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
const now = Date.now();
let child;
try {
  await db.organization.create({data: {id: organizationId, name: "Worker QA"}});
  await db.property.create({data: {id: propertyId, organizationId, name: "Worker QA", timezone: "America/Puerto_Rico", isTestProperty: true, address1: "Synthetic location"}});
  await db.reservation.create({data: {
    id: reservationId, propertyId, guestName: "QA", guestEmail,
    status: "ACTIVE", paymentState: "PAID", source: "DIRECT_BOOKING",
    createdAt: new Date(now - 86400000), checkIn: new Date(now + 7200000), checkOut: new Date(now + 86400000),
    guestJourney: {create: {}}
  }});
  child = spawn(process.execPath, ["--import", "tsx", "src/workers/reservation.worker.ts"], {
    env: {...process.env, GUEST_JOURNEY_CANARY_EXECUTE: "1", MESSAGE_DELIVERY_ACCOUNT_BINDING_ENABLED: "1",
      GUEST_JOURNEY_CANARY_ORGANIZATION_ID: organizationId, GUEST_JOURNEY_CANARY_PROPERTY_ID: propertyId,
      GUEST_JOURNEY_CANARY_RESERVATION_ID: reservationId, GUEST_JOURNEY_CANARY_EMAIL: guestEmail,
      GUEST_JOURNEY_CANARY_SMS: "disabled", RESERVATION_WORKER_POLL_MS: "2000"},
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
  assert.deepEqual(ownership,[{channel:"email",status:"E7_OWNED"}]);
  assert.equal(intents.length,1);
  assert.deepEqual(messages.map(m=>[m.channel,m.providerMessageId]),[["email",null]]);
} finally {
  if (child && child.exitCode === null) { const stopped = once(child,"exit"); child.kill("SIGTERM"); await stopped; }
  await db.$disconnect();
}