import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { prisma } from '../lib/prisma.js';
import { adminHaasRouter } from './admin.haas.routes.js';
process.env.CI='true';process.env.NODE_ENV='test';
async function run(role: string, action: (url:string)=>Promise<void>) {
 const app=express();app.use(express.json());app.use((req,_res,next)=>{(req as any).user={id:'admin',orgId:'platform',role};next();});app.use(adminHaasRouter);
 const server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));
 const port=(server.address() as any).port;
 try {await action(`http://127.0.0.1:${port}`);} finally {await new Promise<void>(resolve=>server.close(()=>resolve()));}
}
test('host roles cannot read or modify platform hardware contracts',async()=>{
 for(const role of ['ADMIN','ORG_ADMIN','MEMBER','CLEANER']) await run(role,async url=>{
  for(const [path,method] of [['','GET'],['/order/locks','GET'],['/order/installation','PATCH']]){
   const response=await fetch(url+'/api/internal/admin/haas'+path,{method});assert.equal(response.status,403);
  }
 });
});
test('platform list exposes selected customer fields, never signup passwords or raw metadata',async()=>{
 const original=prisma.pendingSignup.findMany;
 (prisma.pendingSignup as any).findMany=async({where,select}:any)=>{
  assert.equal(where.status,'COMPLETED');assert.equal(where.metadata.path.join('.'),'haasSelection.plan');assert(!select.passwordHash);
  return [{id:'order',organizationId:'customer',organizationName:'Example',metadata:{haasSelection:{plan:'haas',lock:'essential'},secret:'hidden'},status:'COMPLETED'}];
 };
 try {await run('PLATFORM_ADMIN',async url=>{
  const response=await fetch(url+'/api/internal/admin/haas');assert.equal(response.status,200);const body:any=await response.json();
  assert.equal(body.items[0].selection.model,'essential');assert.equal(body.items[0].metadata,undefined);assert.equal(body.items[0].passwordHash,undefined);
  assert(!JSON.stringify(body).includes('hidden'));
 });} finally {(prisma.pendingSignup as any).findMany=original;await prisma.$disconnect();}
});

test('linked battery is returned from stored DeviceHealth data along with installation details',async()=>{
 const originalList=prisma.pendingSignup.findMany, originalLock=prisma.lock.findFirst;
 (prisma.pendingSignup as any).findMany=async()=>[{id:'order',organizationId:'customer',metadata:{haasSelection:{plan:'haas',lock:'pro'},haasInstallation:{lockId:'lock',installationAddress:'Demo address',serialNumber:'SERIAL-DEMO'}}}];
 (prisma.lock as any).findFirst=async({where,select}:any)=>{
  assert.equal(where.property.organizationId,'customer');assert.equal(select.deviceHealth.select.battery,true);
  return {id:'lock',deviceHealth:{battery:77,batteryLastSuccessfulAt:'2026-10-09T12:00:00Z'}};
 };
 try{await run('PLATFORM_ADMIN',async url=>{
  const response=await fetch(url+'/api/internal/admin/haas');const body:any=await response.json();
  assert.equal(body.items[0].lock.deviceHealth.battery,77);assert.equal(body.items[0].installation.installationAddress,'Demo address');assert.equal(body.items[0].installation.serialNumber,'SERIAL-DEMO');
 });}finally{(prisma.pendingSignup as any).findMany=originalList;(prisma.lock as any).findFirst=originalLock;await prisma.$disconnect();}
});
