import test from 'node:test';import assert from 'node:assert/strict';import express from 'express';
process.env.STRIPE_SECRET_KEY ??= 'sk_test_fixture_not_a_real_key';
const {default:router,signupCheckoutDb:db}=await import('./public.signup.routes.js');
const {default:stripe}=await import('../billing/stripe.js');
const amounts={essential:{12:5499,24:4499},pro:{12:7499,24:6499},elite:{12:8499,24:7499}};
test('signup checkout charges each package once monthly and retains model/term throughout payment metadata',async()=>{
 const original={find:db.dashboardUser.findUnique,create:db.pendingSignup.create,update:db.pendingSignup.update,customer:stripe.customers.create,session:stripe.checkout.sessions.create,price:stripe.prices.retrieve};
 let expectedAmount=0,expectedId='',pending:any,session:any,customer:any;
 (db.dashboardUser as any).findUnique=async()=>null;
 (db.pendingSignup as any).create=async({data}:any)=>{pending=data;return {id:'pending'};};
 (db.pendingSignup as any).update=async()=>({});
 (stripe.customers as any).create=async(data:any)=>{customer=data;return {id:'cus_fixture'};};
 (stripe.prices as any).retrieve=async(id:string)=>{assert.equal(id,expectedId);return {active:true,currency:'usd',unit_amount:expectedAmount,type:'recurring',billing_scheme:'per_unit',recurring:{interval:'month',interval_count:1,usage_type:'licensed'}};};
 (stripe.checkout.sessions as any).create=async(data:any)=>{session=data;return {id:'cs_fixture',url:'https://checkout.stripe.com/fixture'};};
 const app=express();app.use(express.json());app.use(router);const server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));const url=`http://127.0.0.1:${(server.address() as any).port}/api/public/signup-checkout`;
 const base={organizationName:'Rental Demo',fullName:'Demo Host',email:'fixture@example.invalid',phone:'0000000000',password:'Jade!Clouds7Fence',locks:1,billingInterval:'monthly'};
 try{
  for(const [model,values] of Object.entries(amounts))for(const term of [12,24]){
   expectedId=`price_${model}_${term}`;expectedAmount=values[term as 12|24];process.env[`STRIPE_PRICE_HAAS_${model.toUpperCase()}_${term}_MONTHLY`]=expectedId;
   const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...base,contractOption:'standard',haasSelection:{plan:'haas',lock:model,termMonths:term,smartDevices:'none'}})});assert.equal(response.status,200);
   assert.equal(pending.requestedLocks,1);assert.equal(pending.stripePriceId,expectedId);assert.equal(pending.metadata.haasSelection.termMonths,term);
   assert.equal(session.mode,'subscription');assert.deepEqual(session.line_items,[{price:expectedId,quantity:1}]);assert.equal(session.discounts,undefined);
   for(const meta of [customer.metadata,session.metadata,session.subscription_data.metadata]){assert.equal(meta.haasLock,model);assert.equal(meta.haasTermMonths,String(term));assert.equal(meta.contractOption,`contract_${term}_lock`);}
  }
  expectedId='price_platform';expectedAmount=3999;process.env.STRIPE_PRICE_PLATFORM_MONTHLY=expectedId;
  const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...base,plan:'platform',locks:2})});assert.equal(response.status,200);assert.deepEqual(session.line_items,[{price:expectedId,quantity:2}]);
  pending=null;const invalid=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...base,haasSelection:{plan:'haas',lock:'pro',termMonths:6}})});assert.equal(invalid.status,400);assert.equal(pending,null);
 }finally{Object.assign(db.dashboardUser,{findUnique:original.find});Object.assign(db.pendingSignup,{create:original.create,update:original.update});Object.assign(stripe.customers,{create:original.customer});Object.assign(stripe.checkout.sessions,{create:original.session});Object.assign(stripe.prices,{retrieve:original.price});await new Promise<void>(r=>server.close(()=>r()));await db.$disconnect();}
});
