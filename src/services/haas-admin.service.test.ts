import test from 'node:test';
import assert from 'node:assert/strict';
import { haasSelection, recordHaasPayment, saveHaasInstallation } from './haas-admin.service.js';
const created = new Date('2026-10-09T12:00:00Z');
function fixture(meta: any = {haasSelection:{plan:'haas',lock:'pro'},contractOption:'contract_24_lock'}) {
  let writes=0;
  const row:any = {id:'order',status:'COMPLETED',organizationId:'customer-org',stripeCheckoutSessionId:'session',updatedAt:created,metadata:meta};
  const db:any = {pendingSignup:{findUnique:async()=>row, findFirst:async()=>null, updateMany:async({data}:any)=>{writes++;row.metadata=data.metadata;return {count:1};}},lock:{findFirst:async()=>({id:'lock'})}};
  db.$transaction=async(fn:any)=>fn(db);
  return {db,row,writes:()=>writes};
}
const paid:any={id:'session',payment_status:'paid',metadata:{pendingSignupId:'order'},amount_total:6499,currency:'usd'};
const input={expectedUpdatedAt:created.toISOString(),status:'COMPLETED',lockId:'lock',scheduledAt:null,notes:'Installed'};
test('selection uses purchased term and preserves legacy 24-month contracts',()=>{
  assert.equal(haasSelection({haasSelection:{plan:'haas',lock:'pro',termMonths:12}})?.termMonths,12);
  assert.equal(haasSelection({haasSelection:{plan:'haas',lock:'pro'},contractOption:'contract_24_lock'})?.termMonths,24);
  assert.equal(haasSelection({haasSelection:{plan:'haas',lock:'invalid'}}),null);
});
test('only a paid matching Stripe checkout records payment, replay is idempotent',async()=>{
  const f=fixture();await recordHaasPayment(f.db,{...paid,payment_status:'unpaid'},created);assert.equal(f.writes(),0);
  await recordHaasPayment(f.db,{...paid,id:'other-session'},created);assert.equal(f.writes(),0);
  await recordHaasPayment(f.db,paid,created);await recordHaasPayment(f.db,paid,created);assert.equal(f.writes(),1);
  assert.equal(f.row.metadata.haasPayment.amountPaidCents,6499);assert.equal(f.row.metadata.haasSelection.lock,'pro');
});
test('installation requires confirmed payment and rejects cross-organization locks',async()=>{
  const f=fixture();await assert.rejects(saveHaasInstallation(f.db,'order',input,'admin'),/PAYMENT_NOT_CONFIRMED/);
  await recordHaasPayment(f.db,paid,created);f.db.lock.findFirst=async({where}:any)=>{assert.equal(where.property.organizationId,'customer-org');return null;};
  await assert.rejects(saveHaasInstallation(f.db,'order',input,'admin'),/LOCK_NOT_IN_CUSTOMER_ORGANIZATION/);
});
test('conflicting changes, reused locks, missing installed lock and missing scheduled date are rejected',async()=>{
  const f=fixture();await recordHaasPayment(f.db,paid,created);
  await assert.rejects(saveHaasInstallation(f.db,'order',{...input,expectedUpdatedAt:new Date().toISOString()},'admin'),/HAAS_CONCURRENT_UPDATE/);
  await assert.rejects(saveHaasInstallation(f.db,'order',{...input,lockId:null},'admin'),/INSTALLED_LOCK_REQUIRED/);
  await assert.rejects(saveHaasInstallation(f.db,'order',{...input,status:'SCHEDULED'},'admin'),/INSTALLATION_DATE_REQUIRED/);
  f.db.pendingSignup.findFirst=async()=>({id:'another-order'});
  await assert.rejects(saveHaasInstallation(f.db,'order',input,'admin'),/LOCK_ALREADY_ASSIGNED/);
});
test('installation preserves selection/payment and records the admin, concurrent writes fail',async()=>{
  const f=fixture();await recordHaasPayment(f.db,paid,created);await saveHaasInstallation(f.db,'order',input,'admin');
  assert.equal(f.row.metadata.haasInstallation.updatedBy,'admin');assert.equal(f.row.metadata.haasPayment.status,'paid');assert.equal(f.row.metadata.haasSelection.lock,'pro');
  f.db.pendingSignup.updateMany=async()=>({count:0});await assert.rejects(saveHaasInstallation(f.db,'order',input,'admin'),/HAAS_CONCURRENT_UPDATE/);
});
