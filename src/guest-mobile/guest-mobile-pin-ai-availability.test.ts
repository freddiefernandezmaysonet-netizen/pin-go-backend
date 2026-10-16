import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import type { PrismaClient } from "@prisma/client";
import { buildGuestMobilePinAIAvailabilityRouter } from "./guest-mobile-pin-ai-availability.js";
const start = Date.parse("2026-10-25T19:00:00Z"), end = Date.parse("2026-10-29T15:00:00Z");
for (const [instant, enabled, expected] of [[start-1,true,false],[start,true,true],[end-1,true,true],[end,true,false],[start,false,false]] as const) {
 test(`server window ${instant}, enabled ${enabled}`, async () => {
  let linked = true, authenticated = true;
  const db = {
   guestDeviceSession: { findUnique: async () => authenticated ? { id:"device", guestPersonId:"guest", expiresAt:new Date("2026-11-01"), revokedAt:null } : null },
   guestStayLink: { findFirst: async (q:any) => {
    assert.equal(q.where.guestPersonId,"guest"); assert.equal(q.where.revokedAt,null);
    assert.equal(q.where.reservation.reservationNumber,"PG-TEST"); assert.equal(q.where.reservation.status,"ACTIVE");
    return linked ? { reservation:{ id:"reservation",propertyId:"property",guestToken:"private-stay-token",guestTokenExpiresAt:new Date("2026-11-01"),property:{organizationId:"org"} } } : null;
   } },
   reservation: { findUnique: async (q:any) => { assert.deepEqual(q.where,{id:"reservation"}); return {status:"ACTIVE",checkIn:new Date(start+86400000),checkOut:new Date(end-86400000),property:{timezone:"America/Puerto_Rico"}}; } },
  } as unknown as PrismaClient;
  const app=express(); app.use(buildGuestMobilePinAIAvailabilityRouter({prisma:db,now:()=>new Date(instant),env:{PIN_AI_GUEST_GATEWAY_ENABLED:String(enabled)}}));
  const server=app.listen(0,"127.0.0.1"); await new Promise<void>(r=>server.once("listening",r));
  try {
   const port=(server.address() as {port:number}).port, url=`http://127.0.0.1:${port}/api/guest-mobile/stays/PG-TEST/pin-ai/availability`;
   const options={headers:{Authorization:"Bearer synthetic-bearer-0123456789"}};
   assert.equal((await fetch(url)).status,401);
   const response=await fetch(url,options); assert.equal(response.status,200); assert.match(response.headers.get("cache-control")!,/no-store/);
   const p=await response.json(); assert.equal(p.available,expected); assert.equal(p.opensAt,new Date(start).toISOString()); assert.equal(p.closesAt,new Date(end).toISOString()); assert.equal(p.checkedAt,new Date(instant).toISOString()); assert.equal(p.timezone,"America/Puerto_Rico"); assert.ok(!JSON.stringify(p).includes("private-stay-token"));
   linked=false; assert.equal((await fetch(url,options)).status,404);
   authenticated=false; assert.equal((await fetch(url,options)).status,401);
  } finally { await new Promise<void>((r,j)=>server.close(e=>e?j(e):r())); }
 });
}
