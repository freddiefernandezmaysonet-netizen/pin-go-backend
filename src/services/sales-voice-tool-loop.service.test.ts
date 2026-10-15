import assert from "node:assert/strict";
import {EventEmitter} from "node:events";
import {test} from "node:test";
import {withSalesVoiceToolLoop} from "./sales-voice-tool-loop.service.js";
class Socket extends EventEmitter{
  sent:any[]=[];send(raw:string){this.sent.push(JSON.parse(raw));}close(){this.emit("close");}
  event(event:any){this.emit("message",JSON.stringify({type:"response.event",delegation_id:"del_fixture",event}));}
}
const url="wss://api.openai.com/v1/live/sessions/live_fixture/attach";
const options={headers:{Authorization:"Bearer sk-fixture"},maxPayload:65536,handshakeTimeout:5000,perMessageDeflate:false as const};
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
const item=(id:string)=>({type:"response.output_item.done",item:{type:"function_call",call_id:id,name:"get_pingo_product_information",arguments:'{"topic":"overview","language":"es"}'}});
test("completed calls return every result before one response.create, without logging arguments",async()=>{
  const socket=new Socket(),calls:string[]=[],reports:string[]=[];
  withSalesVoiceToolLoop(()=>socket,async(name,args)=>{calls.push(name);assert.ok(args.includes("overview"));return '{"status":"AVAILABLE"}';},s=>reports.push(s))(url,options);
  socket.emit("open");socket.event({type:"response.created",response:{id:"resp_fixture"}});
  socket.event(item("call_first"));socket.event(item("call_second"));socket.event(item("call_first"));
  socket.event({type:"response.completed"});socket.event({type:"response.completed"});await tick();
  assert.equal(calls.length,2);assert.deepEqual(socket.sent.map(x=>x.type),["response.item.create","response.item.create","response.create"]);
  assert.equal(socket.sent[0].item.call_id,"call_first");assert.equal(socket.sent[1].item.call_id,"call_second");
  assert.deepEqual(reports,["RESULT_SENT","RESULT_SENT","CONTINUED"]);
});
test("argument deltas, incomplete items, pre-open and unrelated sessions cannot execute tools",async()=>{
  const socket=new Socket();let calls=0;
  withSalesVoiceToolLoop(()=>socket,async()=>{calls++;return"{}";})(url,options);
  socket.event(item("call_preopen"));socket.emit("open");
  socket.event({type:"response.function_call_arguments.done",arguments:"{}"});
  socket.emit("message",JSON.stringify({type:"response.event",session_id:"live_other",event:item("call_wrong")}));
  socket.event({type:"response.output_item.done",item:{type:"function_call",call_id:"bad",name:"private"}});
  await tick();assert.equal(calls,0);assert.equal(socket.sent.length,0);
});
test("disconnect during a pending read prevents any result or continuation after close",async()=>{
  const socket=new Socket();let finish!:(s:string)=>void;
  withSalesVoiceToolLoop(()=>socket,()=>new Promise(resolve=>{finish=resolve;}))(url,options);
  socket.emit("open");socket.event(item("call_pending"));socket.event({type:"response.completed"});await tick();
  socket.close();finish("{}");await tick();assert.equal(socket.sent.length,0);
});
test("read failure returns a safe unavailable result and resumes the response",async()=>{
  const socket=new Socket();withSalesVoiceToolLoop(()=>socket,async()=>{throw Error("PRIVATE_KEY");},()=>{})(url,options);
  socket.emit("open");socket.event(item("call_failure"));socket.event({type:"response.completed"});await tick();
  assert.equal(socket.sent[1].type,"response.create");assert.ok(!JSON.stringify(socket.sent).includes("PRIVATE"));
  assert.equal(JSON.parse(socket.sent[0].item.output).status,"UNAVAILABLE");
});
test("a subsequent backend response can call another tool in the same delegation",async()=>{
  const socket=new Socket();withSalesVoiceToolLoop(()=>socket,async()=>"{}",()=>{})(url,options);socket.emit("open");
  for(const id of ["call_round1","call_round2"]){
    socket.event({type:"response.created"});socket.event(item(id));socket.event({type:"response.completed"});await tick();
  }
  assert.equal(socket.sent.filter(x=>x.type==="response.create").length,2);
});
test("a provider error during backend work requests an immediate honest reply once without copying the error",async()=>{
  const socket=new Socket();withSalesVoiceToolLoop(()=>socket,async()=>"{}",()=>{})(url,options);socket.emit("open");
  socket.event({type:"response.created"});await tick();
  for(let i=0;i<2;i++)socket.emit("message",JSON.stringify({type:"error",error:{message:"PRIVATE_KEY"}}));
  assert.equal(socket.sent.length,1);assert.equal(socket.sent[0].type,"session.instructions.append");
  assert.equal(socket.sent[0].delegation_id,null);assert.ok(!JSON.stringify(socket.sent).includes("PRIVATE"));
});
