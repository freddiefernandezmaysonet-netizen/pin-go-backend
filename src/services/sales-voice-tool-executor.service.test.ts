import assert from "node:assert/strict";
import {test} from "node:test";
import {createSalesVoiceToolExecutor} from "./sales-voice-tool-executor.service.js";

test("backend tool returns bilingual public facts without source paths or account data",async()=>{
  const execute=createSalesVoiceToolExecutor({},async()=>{throw Error("must not read prices");});
  for(const language of ["es","en"]){
    const result=JSON.parse(await execute("get_pingo_product_information",JSON.stringify({topic:"overview",language})));
    assert.equal(result.status,"AVAILABLE");assert.equal(result.facts.length,8);
    assert.ok(result.overview.includes("Pin&Go"));assert.ok(!JSON.stringify(result).includes("src/"));
  }
  const direct=JSON.parse(await execute("get_pingo_product_information",'{"topic":"direct_booking","language":"es"}'));
  assert.equal(direct.facts.length,1);assert.ok(direct.facts[0].information.includes("SI cuenta"));
});
test("malformed arguments, unknown tools and attempts to request private data never execute reads",async()=>{
  let reads=0;const execute=createSalesVoiceToolExecutor({},async()=>{reads++;},async()=>{reads++;throw Error();});
  for(const [name,args] of [
    ["execute_sql",'{"query":"SELECT *"}'],["get_pingo_current_prices",'{"organizationId":"PRIVATE"}'],
    ["get_pingo_product_information",'{"topic":"private_reservations","language":"es"}'],
    ["get_pingo_product_information",'{"topic":"overview","language":"es","tenant":"PRIVATE"}'],
    ["search_pingo_official_website",'{"query":"pricing","url":"http://127.0.0.1"}'],
    ["get_pingo_current_prices","null"],["get_pingo_current_prices","[]"],["get_pingo_current_prices","invalid"],
  ])assert.equal(JSON.parse(await execute(name,args)).status,"UNAVAILABLE");
  assert.equal(reads,0);
});
test("price tool reads fresh live checkout-compatible data on each invocation",async()=>{
  let reads=0;const execute=createSalesVoiceToolExecutor({NODE_ENV:"production",STRIPE_PRICE_PLATFORM_MONTHLY:"price_fixture"},async()=>{
    reads++;return{object:"price",id:"price_fixture",active:true,livemode:true,currency:"usd",unit_amount:3999,type:"recurring",
      tax_behavior:"exclusive",billing_scheme:"per_unit",recurring:{interval:"month",interval_count:1,usage_type:"licensed"}};
  });
  for(let i=0;i<2;i++){
    const value=JSON.parse(await execute("get_pingo_current_prices","{}"));
    assert.ok(value.catalog.includes("VERIFIED USD 39.99"));assert.ok(!value.catalog.includes("price_fixture"));
  }
  assert.equal(reads,2);
});
test("website tool fetches the fixed public landing, strips scripts and returns bounded matching text",async()=>{
  const seen:string[]=[];
  const execute=createSalesVoiceToolExecutor({},async()=>null,async(url,init)=>{
    seen.push(url);assert.equal(init.redirect,"manual");assert.ok(init.signal);
    return new Response('<html><script>PRIVATE_SCRIPT</script><style>PRIVATE_STYLE</style><h1>Pin&amp;Go</h1><p>'+"Reservas directas, limpieza y acceso inteligente. ".repeat(40)+"</p></html>",{headers:{"content-type":"text/html"}});
  });
  const result=JSON.parse(await execute("search_pingo_official_website",'{"query":"reservas directas"}'));
  assert.equal(result.status,"AVAILABLE");assert.deepEqual(seen,["https://www.pin-ngo.com/pingo-commercial-knowledge.json","https://pin-ngo.com/"]);
  assert.ok(result.content.includes("Pin&Go"));assert.ok(!result.content.includes("PRIVATE"));
  assert.ok(result.content.length<7500);
});
test("website tool rejects offsite redirects, non-HTML, oversized and empty rendered content",async()=>{
  for(const response of [
    ()=>new Response(null,{status:302,headers:{location:"http://169.254.169.254/"}}),
    ()=>new Response("PRIVATE",{headers:{"content-type":"application/json"}}),
    ()=>new Response("<html><script>only client rendered</script></html>",{headers:{"content-type":"text/html"}}),
    ()=>new Response("x".repeat(1024*1024+1),{headers:{"content-type":"text/html"}}),
  ]){
    let requests=0;const execute=createSalesVoiceToolExecutor({},async()=>null,async()=>{requests++;return response();});
    assert.equal(JSON.parse(await execute("search_pingo_official_website",'{"query":"PinGo"}')).status,"UNAVAILABLE");
    assert.ok(requests >= 1 && requests <= 2);
  }
});
test("JavaScript landing knowledge is read from the build-generated public feed",async()=>{
  const execute=createSalesVoiceToolExecutor({},async()=>null,async(url)=>{
    assert.equal(url,"https://www.pin-ngo.com/pingo-commercial-knowledge.json");
    return new Response(JSON.stringify({schemaVersion:1,source:"https://www.pin-ngo.com/",contentVersion:"a".repeat(64),builtAt:"2026-10-15T00:00:00Z",
      languages:{es:"Reservas directas y limpieza. ".repeat(20),en:"Direct booking and cleaning. ".repeat(20)}}),{headers:{"content-type":"application/json"}});
  });
  const value=JSON.parse(await execute("search_pingo_official_website",'{"query":"limpieza"}'));
  assert.equal(value.status,"AVAILABLE");assert.equal(value.contentVersion,"a".repeat(64));assert.ok(value.content.includes("limpieza"));
});
