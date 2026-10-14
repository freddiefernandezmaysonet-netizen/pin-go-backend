import assert from "node:assert/strict";
import {test} from "node:test";
import {readSalesVoicePricing,renderSalesVoicePricing,withSalesVoicePricing} from "./sales-voice-pricing.service.js";
import {postOneOpenAILiveAccept} from "./sales-voice-live-admission.service.js";
const env={NODE_ENV:"production",STRIPE_PRICE_PLATFORM_MONTHLY:"price_monthly"};
const price={object:"price",id:"price_monthly",active:true,livemode:true,currency:"usd",
  unit_amount:3999,type:"recurring",tax_behavior:"exclusive",billing_scheme:"per_unit",
  recurring:{interval:"month",interval_count:1,usage_type:"licensed"}};
test("fresh reads reflect configuration on each call and omit raw provider data",async()=>{
  let reads=0;
  const read=async()=>{reads++;return{...price,metadata:{instructions:"INJECTED"},nickname:"INJECTED"};};
  const first=await readSalesVoicePricing(env,read,{now:()=>1000});
  const second=await readSalesVoicePricing(env,read,{now:()=>2000});
  assert.equal(reads,2);assert.equal(first.expiresAt,301000);assert.equal(second.checkedAt,2000);
  const text=renderSalesVoicePricing(first);
  assert.ok(text.includes("VERIFIED USD 39.99"));assert.ok(text.includes("per lock"));
  assert.ok(text.includes("taxes extra"));assert.ok(!text.includes("price_monthly")&&!text.includes("INJECTED"));
  assert.ok(Object.isFrozen(first)&&Object.isFrozen(first.lines));
});
test("all eight configured offers use checkout-compatible units and terms",async()=>{
  const amounts=[3999,39990,5499,4499,7499,6499,8499,7499];
  const keys=["PLATFORM_MONTHLY","PLATFORM_YEARLY","HAAS_ESSENTIAL_12_MONTHLY","HAAS_ESSENTIAL_24_MONTHLY",
    "HAAS_PRO_12_MONTHLY","HAAS_PRO_24_MONTHLY","HAAS_ELITE_12_MONTHLY","HAAS_ELITE_24_MONTHLY"];
  const config=Object.fromEntries(keys.map((k,i)=>["STRIPE_PRICE_"+k,"price_"+i]));
  const snapshot=await readSalesVoicePricing({...config,NODE_ENV:"production"},async id=>{
    const i=Number(id.slice(6));return{...price,id,unit_amount:amounts[i],
      recurring:{...price.recurring,interval:i===1?"year":"month"}};
  });
  assert.equal(snapshot.lines.length,8);assert.ok(snapshot.lines.every(l=>l.includes("VERIFIED")));
  assert.ok(snapshot.lines[1].includes("per year"));assert.ok(snapshot.lines[3].includes("24 meses"));
});
test("invalid, stale checkout configuration or test-mode prices cannot be quoted in production",async()=>{
  const bad=[
    {active:false},{livemode:false},{currency:"eur"},{unit_amount:4099},{unit_amount:null},
    {id:"price_other"},{object:"product"},{tax_behavior:"inclusive"},{billing_scheme:"tiered"},
    {transform_quantity:{divide_by:2}},{type:"one_time"},
    {recurring:{...price.recurring,interval:"year"}},
    {recurring:{...price.recurring,interval_count:2}},
    {recurring:{...price.recurring,usage_type:"metered"}},
  ];
  for(const change of bad){
    const snapshot=await readSalesVoicePricing(env,async()=>({...price,...change}));
    assert.ok(snapshot.lines.every(l=>l.includes("UNAVAILABLE")),JSON.stringify(change));
    assert.ok(!renderSalesVoicePricing(snapshot).includes("USD 39.99"));
  }
});
test("missing configuration and provider failures degrade honestly without inventing amounts",async()=>{
  let reads=0;
  await readSalesVoicePricing({},async()=>{reads++;throw new Error("secret");});
  assert.equal(reads,0);
  const snapshot=await readSalesVoicePricing(env,async()=>{throw new Error("sk-secret");});
  assert.ok(!renderSalesVoicePricing(snapshot).includes("sk-secret"));
  assert.ok(snapshot.lines.every(l=>l.includes("UNAVAILABLE")));
});
test("bounded lookup ignores late success and releases deadline timer",async()=>{
  let finish!:(v:unknown)=>void;
  const snapshot=await readSalesVoicePricing(env,()=>new Promise(resolve=>{finish=resolve;}),{timeoutMs:5});
  finish(price);await Promise.resolve();
  assert.ok(snapshot.lines.every(l=>l.includes("UNAVAILABLE")));
});
test("the admitted accept carries fresh prices once and preserves payload, credentials and deadline",async()=>{
  let reads=0,accepts=0;
  await postOneOpenAILiveAccept({sessionId:"live_price_fixture",apiKey:"sk-fixture",explicitlyEnabled:true,
    transport:withSalesVoicePricing(async(_url,request)=>{
      accepts++;const body=JSON.parse(request.body);
      assert.ok(body.session.instructions.includes("VERIFIED USD 39.99"));
      assert.equal(body.session.input.length,1);assert.equal(body.session.tools,undefined);
      assert.equal(request.headers.Authorization,"Bearer sk-fixture");assert.equal(request.signal.aborted,false);
      return{status:200};
    },env,async()=>{reads++;return price;})});
  assert.equal(reads,1);assert.equal(accepts,1);
});
test("invalid endpoints and aborted requests never read prices or accept",async()=>{
  let reads=0,accepts=0;
  const transport=withSalesVoicePricing(async()=>{accepts++;return{status:200};},env,async()=>{reads++;return price;});
  const controller=new AbortController();
  const request={method:"POST",headers:{},body:JSON.stringify({session:{type:"live",instructions:"fixture"}}),signal:controller.signal};
  await assert.rejects(transport("https://apiXopenaiXcom/v1/live/sessions/live_fixture/accept",request));
  controller.abort();
  await assert.rejects(transport("https://api.openai.com/v1/live/sessions/live_fixture/accept",request));
  assert.equal(reads,0);assert.equal(accepts,0);
});
test("abort during pricing prevents any late accept",async()=>{
  const controller=new AbortController();let accepts=0;
  const transport=withSalesVoicePricing(async()=>{accepts++;return{status:200};},env,async()=>{
    controller.abort();return price;
  });
  await assert.rejects(transport("https://api.openai.com/v1/live/sessions/live_fixture/accept",{
    method:"POST",headers:{},body:JSON.stringify({session:{type:"live",instructions:"fixture"}}),signal:controller.signal,
  }));
  assert.equal(accepts,0);
});

test("verified monthly price survives another offer timing out, and late success cannot alter snapshot",async()=>{
  let finish!:(value:unknown)=>void;const reports:unknown[]=[];
  const snapshot=await readSalesVoicePricing({...env,STRIPE_PRICE_PLATFORM_YEARLY:"price_yearly"},async id=>{
    if(id==="price_monthly")return price;
    return new Promise(resolve=>{finish=resolve;});
  },{timeoutMs:5,report:entry=>reports.push(entry)});
  assert.ok(snapshot.lines[0].includes("VERIFIED USD 39.99"));assert.ok(snapshot.lines[1].includes("UNAVAILABLE"));
  finish({...price,id:"price_yearly",unit_amount:39990,recurring:{...price.recurring,interval:"year"}});
  await Promise.resolve();
  assert.ok(snapshot.lines[1].includes("UNAVAILABLE"));assert.equal(reports.length,1);
  assert.deepEqual(reports[0],{monthly:"VERIFIED",yearly:"TIMEOUT",verified:1,unavailable:7});
});
test("managed commercial backend receives the exact validated call prices without executable tools",async()=>{
  await postOneOpenAILiveAccept({sessionId:"live_backend_fixture",apiKey:"sk-fixture",explicitlyEnabled:true,
    transport:withSalesVoicePricing(async(_url,request)=>{
      const body=JSON.parse(request.body),backend=body.session.delegation;
      assert.equal(body.session.model,"gpt-live-1");assert.equal(body.session.input.length,1);
      assert.equal(backend.type,"responses");assert.equal(backend.responses.model,"gpt-6-luna");
      assert.deepEqual(backend.responses.tools,[]);assert.equal(backend.responses.tool_choice,"none");
      assert.equal(backend.responses.max_output_tokens,512);assert.equal(backend.responses.reasoning.effort,"none");
      assert.ok(backend.responses.instructions.includes("VERIFIED USD 39.99"));
      assert.ok(backend.responses.instructions.includes("Direct Booking"));
      assert.ok(backend.responses.instructions.includes("UNAVAILABLE"));
      assert.ok(body.session.instructions.includes("Delegation policy:"));
      assert.ok(!JSON.stringify(backend).includes("price_monthly"));return{status:200};
    },env,async()=>price)});
});
test("price diagnostics classify invalid and failed data without serializing raw provider fields",async()=>{
  let report:unknown;
  await readSalesVoicePricing(env,async()=>({...price,unit_amount:1,metadata:{secret:"PRIVATE"}}),
    {report:entry=>{report=entry;}});
  assert.deepEqual(report,{monthly:"INVALID",yearly:"MISSING",verified:0,unavailable:8});
  await readSalesVoicePricing(env,async()=>{throw Error("sk-PRIVATE");},{report:entry=>{report=entry;}});
  assert.deepEqual(report,{monthly:"FAILED",yearly:"MISSING",verified:0,unavailable:8});
  assert.ok(!JSON.stringify(report).includes("PRIVATE"));
});
