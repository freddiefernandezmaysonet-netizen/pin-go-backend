import assert from "node:assert/strict";
import {test} from "node:test";
import {diagnoseSalesVoiceIngress} from "./sales-voice-ingress-diagnostics.service.js";
test("ingress logs allowlisted rejection and bounded runtime state then preserves original error",async()=>{
  const error=new Error("CERTIFICATION_ATTEMPT_LIMIT");let entry:unknown;
  await assert.rejects(diagnoseSalesVoiceIngress(async()=>{throw error;},
    ()=>({started:true,stopped:false,pending:1,observers:0,ready:true}),
    value=>{entry=value;}),value=>value===error);
  assert.deepEqual(entry,{code:"CERTIFICATION_ATTEMPT_LIMIT",started:true,stopped:false,ready:true,pending:1,observers:0});
});
test("raw credentials, phone, invitation and database error details cannot enter diagnostics",async()=>{
  let entry:unknown;const error={code:"P1001",message:"sk-secret +19390000000",meta:{secret:"private"}};
  await assert.rejects(diagnoseSalesVoiceIngress(async()=>{throw error;},undefined,value=>{entry=value;}));
  assert.deepEqual(entry,{code:"P1001"});
  await assert.rejects(diagnoseSalesVoiceIngress(async()=>{throw Error("sk-secret");},undefined,value=>{entry=value;}));
  assert.deepEqual(entry,{code:"UNCLASSIFIED"});
});
test("success is not logged and reporter or snapshot failures cannot change rejection",async()=>{
  let logs=0;assert.equal(await diagnoseSalesVoiceIngress(async()=>42,undefined,()=>{logs++;}),42);
  assert.equal(logs,0);const error=Error("SALES_RUNTIME_DISABLED");
  await assert.rejects(diagnoseSalesVoiceIngress(async()=>{throw error;},()=>{throw Error("snapshot");},
    ()=>{throw Error("logger");}),e=>e===error);
});
