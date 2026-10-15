import assert from "node:assert/strict";
import {EventEmitter} from "node:events";
import {test} from "node:test";
import {withSalesVoiceFarewell} from "./sales-voice-farewell.service.js";
function setup(){
  const socket=new EventEmitter() as EventEmitter&{close:()=>void};socket.close=()=>socket.emit("close");
  const timers=new Set<()=>void>();let calls=0,valid:(()=>boolean)|undefined;
  withSalesVoiceFarewell(()=>socket,async wanted=>{calls++;valid=wanted;},(task,delay)=>{
    assert.equal(delay,2500);timers.add(task);return()=>{timers.delete(task);};
  })("wss://api.openai.com/v1/live/sessions/live_test/attach",{headers:{Authorization:"Bearer sk-test"},maxPayload:65536,handshakeTimeout:5000,perMessageDeflate:false});
  socket.emit("open");
  const emit=(type:string,delta?:string,extra={})=>socket.emit("message",JSON.stringify({type,delta,...extra}));
  const user=(s:string)=>emit("session.input_transcript.delta",s);
  const say=(s:string)=>emit("session.output_transcript.delta",s);
  const flush=()=>{for(const task of [...timers]){timers.delete(task);task();}};
  return {socket,emit,user,say,flush,get calls(){return calls;},get pending(){return timers.size;},get valid(){return valid?.();}};
}
test("explicit Spanish close split across fragments waits for the spoken farewell and quiet, then hangs up once",()=>{
  const d=setup();d.user("Eso es to");d.user("do, muchas gracias.");d.flush();assert.equal(d.calls,0);
  d.say("Gracias por llamar a Pin&Go. Hasta luego.");assert.equal(d.calls,0);d.flush();d.flush();assert.equal(d.calls,1);assert.equal(d.valid,true);
});
test("English explicit endings are supported",()=>{const d=setup();d.user("That's all, thank you.");d.say("Thank you for calling. Goodbye!");d.flush();assert.equal(d.calls,1);});
test("thanks alone, ongoing questions and negated endings never hang up",()=>{
  for(const text of ["Gracias","Muchas gracias, ¿cuánto cuesta?","Eso es todo pero tengo otra pregunta","No cuelgues, hasta luego digo al final","Thanks, what is PinGo?","That's all but wait"]){
    const d=setup();d.user(text);d.say("Gracias por llamar, hasta luego.");d.flush();assert.equal(d.calls,0,text);
  }
});
test("a new caller question cancels a pending goodbye and invalidates a hangup already being fenced",()=>{
  const d=setup();d.user("Eso es todo.");d.say("Hasta luego.");d.user("Espera, tengo otra pregunta.");d.flush();assert.equal(d.calls,0);
  const e=setup();e.user("Goodbye.");e.say("Goodbye!");e.flush();assert.equal(e.valid,true);e.user("Wait!");assert.equal(e.valid,false);
});
test("audible output postpones closure while continuous silent audio does not",()=>{
  const d=setup();d.user("Eso es todo.");d.say("Hasta luego.");
  const pcm=Buffer.alloc(20);pcm.writeInt16LE(1500);d.emit("session.output_audio.delta",pcm.toString("base64"));assert.equal(d.pending,1);
  d.emit("session.output_audio.delta",Buffer.alloc(20).toString("base64"));d.flush();assert.equal(d.calls,1);
});
test("pending backend work must finish before closing",()=>{
  const d=setup();d.user("Eso es todo.");d.say("Hasta luego.");d.emit("response.event",undefined,{event:{type:"response.created"}});d.flush();assert.equal(d.calls,0);
  d.emit("response.event",undefined,{event:{type:"response.completed"}});d.flush();assert.equal(d.calls,1);
});
test("disconnect, provider closure and wrong session cannot close a call",()=>{
  for(const action of ["close","error","session.closed"]){const d=setup();d.user("Eso es todo.");d.say("Hasta luego.");action==="session.closed"?d.emit(action):d.socket.emit(action,...(action==="error"?[new Error("test")]:[]));d.flush();assert.equal(d.calls,0);}
  const d=setup();d.emit("session.input_transcript.delta","Eso es todo.",{session_id:"live_other"});d.say("Hasta luego.");d.flush();assert.equal(d.calls,0);
});

test("Live backchannels between caller transcript fragments do not erase the ending",()=>{
  const d=setup();
  d.emit("session.input_transcript.delta","Eso es ",{start_ms:10000,end_ms:10300});
  d.emit("session.output_transcript.delta"," [hum] ",{start_ms:10200,end_ms:10400});
  d.emit("session.input_transcript.delta","todo, muchas gracias.",{start_ms:10300,end_ms:11200});
  d.emit("session.output_transcript.delta","Hasta luego.",{start_ms:12000,end_ms:13000});
  d.flush();assert.equal(d.calls,1);
});
test("a previous question is separated by the caller audio timeline",()=>{
 const d=setup();d.emit("session.input_transcript.delta","¿Cuánto cuesta?",{start_ms:1000,end_ms:2000});
 d.say("Cuesta la tarifa verificada.");
 d.emit("session.input_transcript.delta","Eso es todo, gracias.",{start_ms:7000,end_ms:8000});d.say("Hasta luego.");d.flush();assert.equal(d.calls,1);
});
test("late caller fragments spoken before the farewell do not cancel closing",()=>{
 const d=setup();d.emit("session.input_transcript.delta","Eso es todo.",{start_ms:1000,end_ms:1800});
 d.emit("session.output_transcript.delta","Hasta luego.",{start_ms:2500,end_ms:3300});
 d.emit("session.input_transcript.delta"," Muchas gracias.",{start_ms:1800,end_ms:2300});d.flush();assert.equal(d.calls,1);
});
