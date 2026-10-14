import assert from "node:assert/strict";
import {test} from "node:test";
import {existsSync} from "node:fs";
import {resolve} from "node:path";
import {salesVoiceProductFacts,buildSalesVoiceProductKnowledge,
  buildSalesVoiceSalesCoaching,SALES_VOICE_PRODUCT_KNOWLEDGE_SOURCE_COMMIT} from "./sales-voice-product-knowledge.service.js";
import {postOneOpenAILiveAccept,type ProviderHTTP} from "./sales-voice-live-admission.service.js";

test("reviewed bilingual knowledge has repository evidence and cannot be mutated",()=>{
  assert.match(SALES_VOICE_PRODUCT_KNOWLEDGE_SOURCE_COMMIT,/^[a-f0-9]{40}$/);
  assert.equal(new Set(salesVoiceProductFacts.map(f=>f.id)).size,salesVoiceProductFacts.length);
  assert.equal(salesVoiceProductFacts.length,8);
  for(const f of salesVoiceProductFacts){
    assert.ok(f.es.length>20&&f.en.length>20&&f.limit.length>20&&f.sources.length>0);
    assert.ok(Object.isFrozen(f)&&Object.isFrozen(f.sources));
    for(const path of f.sources)assert.ok(existsSync(resolve(path)),path);
  }
  assert.equal(Reflect.set(salesVoiceProductFacts[0],"es","Invented capability"),false);
  assert.equal(salesVoiceProductFacts[0].es.includes("Direct Booking"),true);
});
test("caller-facing knowledge omits internal evidence and does not freeze a price quote",()=>{
  const text=buildSalesVoiceProductKnowledge();
  assert.ok(text.length<16000);
  assert.ok(!text.includes(SALES_VOICE_PRODUCT_KNOWLEDGE_SOURCE_COMMIT));
  assert.ok(!text.includes("src/")&&!text.includes("process.env"));
  assert.ok(!/\$\s*\d|USD\s*\d|US\$\s*\d/.test(text));
  assert.match(text,/No hay una consulta de precios vigentes conectada/);
  assert.match(text,/no prueba de activacion en la cuenta/);
});
test("actual Live acceptance carries product knowledge and sales coaching without executable tools",async()=>{
  let requests=0;
  const transport:ProviderHTTP=async(_url,request)=>{
    requests++;const body=JSON.parse(request.body),instructions=body.session.instructions;
    assert.ok(instructions.includes(buildSalesVoiceProductKnowledge()));
    assert.ok(instructions.includes(buildSalesVoiceSalesCoaching()));
    assert.match(instructions,/usuario de otro PMS/);
    assert.match(instructions,/una sola pregunta relevante/);
    assert.match(instructions,/resultado verificado/);
    assert.equal(body.session.tools,undefined);
    assert.equal(body.session.input.length,1);
    return{status:200};
  };
  await postOneOpenAILiveAccept({sessionId:"live_knowledge_fixture",apiKey:"sk-fixture",
    explicitlyEnabled:true,transport});
  assert.equal(requests,1);
});
