import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { buildHostCleaningsRouter } from "./host-cleanings.routes.js";
test("host endpoint rejects unauthenticated/cleaner users, binds organization and never exposes tokens", async () => {
 const oldCi=process.env.CI, oldNode=process.env.NODE_ENV;
 process.env.CI="true"; process.env.NODE_ENV="test";
 const calls: any[]=[];
 const db: any={ $queryRaw:async(q:any)=>{calls.push(q);return [];},property:{findMany:async(q:any)=>{calls.push(q);return [];}},cleaningConfirmation:{findMany:async()=>[]},reservation:{findMany:async()=>[]},staffMember:{findMany:async()=>[]},cleaningWork:{findMany:async()=>[]},cleaningTaskChecklist:{findMany:async()=>[]} };
 const app=express();app.use((req:any,_res,next)=>{const role=req.get("x-test-role");if(role)req.user={id:"user",orgId:"own",role};next();});app.use(buildHostCleaningsRouter(db));
 const server=app.listen(0,"127.0.0.1"); await new Promise<void>(resolve=>server.once("listening",resolve));
 const url=`http://127.0.0.1:${(server.address() as any).port}/api/host/cleanings`;
 try {
  assert.equal((await fetch(url)).status,401);
  assert.equal((await fetch(url,{headers:{"x-test-role":"CLEANER"}})).status,403);
  assert.equal((await fetch(url,{headers:{"x-test-role":"VIEWER"}})).status,403);
  assert.equal(calls.length,0);
  const result=await fetch(`${url}?organizationId=other&view=all`,{headers:{"x-test-role":"ORG_ADMIN"}});
  assert.equal(result.status,200);assert.equal(result.headers.get("cache-control"),"no-store");
  assert.ok(calls[0].values.includes("own"));assert.equal(calls[0].values.includes("other"),false);
  assert.equal(calls[1].where.organizationId,"own");assert.deepEqual((await result.json() as any).items,[]);
  assert.equal((await fetch(`${url}?view=wrong`,{headers:{"x-test-role":"ORG_ADMIN"}})).status,400);
 } finally {await new Promise<void>(resolve=>server.close(()=>resolve()));if(oldCi===undefined)delete process.env.CI;else process.env.CI=oldCi;if(oldNode===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=oldNode;}
});
