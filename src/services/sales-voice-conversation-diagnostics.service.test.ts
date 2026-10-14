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
  socket.emit("message",JSON.stringify({type:"session.delegation.created",delegation_id:"PRIVATE_ID"}));
  socket.emit("message",JSON.stringify({type:"response.event",event:{type:"response.completed",output:["private"]}}));
  socket.close();
  assert.deepEqual(logs.at(-1),{inputSeen:true,outputSeen:true,outputBeforeInput:true,delegations:1,completed:1,failed:0,validationFailed:false});
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
  assert.deepEqual(logs.at(-1),{inputSeen:true,outputSeen:true,outputBeforeInput:false,delegations:0,completed:0,failed:1,validationFailed:true});
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
