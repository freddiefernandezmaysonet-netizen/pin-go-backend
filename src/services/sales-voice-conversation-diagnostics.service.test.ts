import assert from "node:assert/strict";
import {test} from "node:test";
import {withSalesVoiceConversationDiagnostics} from "./sales-voice-conversation-diagnostics.service.js";
class Socket{
  callbacks=new Map<string,Array<(...args:unknown[])=>void>>();
  on(event:string,cb:(...args:unknown[])=>void){this.callbacks.set(event,[...(this.callbacks.get(event)??[]),cb]);return this;}
  emit(event:string,value?:unknown){for(const cb of this.callbacks.get(event)??[])cb(value);}
  close(){this.emit("close");}
}
const url="wss://api.openai.com/v1/live/sessions/live_fixture/attach";
const options={headers:{Authorization:"Bearer sk-fixture"},handshakeTimeout:5000,maxPayload:16384,perMessageDeflate:false as const};
test("passive diagnostics track greeting ordering and backend completion without retaining conversation",()=>{
  const socket=new Socket(),logs:unknown[]=[];
  const connect=withSalesVoiceConversationDiagnostics(()=>socket,value=>logs.push(value));
  assert.equal(connect(url,options),socket);
  socket.emit("open");
  socket.emit("message",JSON.stringify({type:"session.output_transcript.delta",delta:"SECRET SPOKEN TEXT"}));
  socket.emit("message",JSON.stringify({type:"session.input_transcript.delta",delta:"+19390000000"}));
  socket.emit("message",JSON.stringify({type:"session.delegation.created",delegation:{id:"PRIVATE_ID",target:"responses",type:"delegation",response_id:"PRIVATE_RESPONSE"}}));
  socket.emit("message",JSON.stringify({type:"response.event",event:{type:"response.created"}}));
  socket.emit("message",JSON.stringify({type:"response.event",event:{type:"response.output_text.delta",delta:"PRIVATE ANSWER"}}));
  socket.emit("message",JSON.stringify({type:"response.event",event:{type:"response.completed",output:["private"]}}));
  socket.close();
  assert.deepEqual(logs.at(-1),{inputSeen:true,outputSeen:true,outputBeforeInput:true,delegations:1,completed:1,failed:0,validationFailed:false,
    clientDelegations:0,responsesDelegations:1,backendStarted:1,backendTextSeen:true,providerErrors:0});
  const serialized=JSON.stringify(logs);
  for(const value of ["SECRET","1939","PRIVATE","sk-fixture"])assert.ok(!serialized.includes(value));
});
test("caller-first order, validation failure and incomplete backend are visible without raw error",()=>{
  const socket=new Socket(),logs:unknown[]=[];
  withSalesVoiceConversationDiagnostics(()=>socket,value=>logs.push(value))(url,options);
  socket.emit("open");
  for(const event of [
    {type:"session.input_transcript.delta"},
    {type:"session.output_transcript.delta"},
    {type:"error",error:{code:"responses_validation_failed",message:"sk-PRIVATE"}},
    {type:"response.event",event:{type:"response.incomplete"}},
  ])socket.emit("message",JSON.stringify(event));
  assert.deepEqual(logs.at(-1),{inputSeen:true,outputSeen:true,outputBeforeInput:false,delegations:0,completed:0,failed:1,validationFailed:true,
    clientDelegations:0,responsesDelegations:0,backendStarted:0,backendTextSeen:false,providerErrors:1});
});
test("client-owned work and unknown provider errors are visible without copying untrusted fields",()=>{
  const socket=new Socket(),logs:unknown[]=[];
  withSalesVoiceConversationDiagnostics(()=>socket,value=>logs.push(value))(url,options);
  socket.emit("open");
  socket.emit("message",JSON.stringify({type:"session.delegation.created",delegation:{target:"client",id:"PRIVATE"}}));
  socket.emit("message",JSON.stringify({type:"error",error:{code:"PRIVATE_TOKEN",message:"PRIVATE_TEXT"}}));
  const summary=logs.at(-1) as Record<string,unknown>;
  assert.equal(summary.clientDelegations,1);assert.equal(summary.responsesDelegations,0);
  assert.equal(summary.backendStarted,0);assert.equal(summary.providerErrors,1);
  assert.ok(!JSON.stringify(logs).includes("PRIVATE"));
});
test("default telemetry is one JSON line so filtering keeps all diagnostic fields",()=>{
  const socket=new Socket(),lines:unknown[][]=[];
  const original=console.info;
  try{
    console.info=(...args:unknown[])=>{lines.push(args);};
    withSalesVoiceConversationDiagnostics(()=>socket)(url,options);
    socket.emit("open");socket.emit("message",JSON.stringify({type:"session.delegation.created",delegation:{target:"responses"}}));
  }finally{console.info=original;}
  assert.equal(lines.length,1);assert.equal(lines[0].length,1);
  const line=String(lines[0][0]);assert.ok(!line.includes("\n"));
  assert.equal(JSON.parse(line.slice(line.indexOf("{"))).responsesDelegations,1);
});
test("pre-open, malformed, unrelated sessions and logger failure do not control the socket",()=>{
  const socket=new Socket();let reports=0;
  withSalesVoiceConversationDiagnostics(()=>socket,()=>{reports++;throw Error("logger");})(url,options);
  socket.emit("message",JSON.stringify({type:"session.input_transcript.delta"}));
  socket.emit("open");socket.emit("message","invalid");
  socket.emit("message",JSON.stringify({session_id:"live_other",type:"session.output_transcript.delta"}));
  assert.equal(reports,0);
  socket.emit("message",JSON.stringify({type:"session.output_transcript.delta"}));assert.equal(reports,1);
  socket.close();assert.equal(reports,2);
});
