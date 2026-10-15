import {randomUUID} from "node:crypto";
import type {SidebandSocketFactory} from "./sales-voice-sideband-supervisor.service.js";
import type {CommercialToolExecutor} from "./sales-voice-tool-executor.service.js";
import {SALES_VOICE_SIDEBAND_MAX_MESSAGE_BYTES} from "./sales-voice-protocol-limits.service.js";
type State={outputs:number;continued:boolean};

/** Execute completed read-only function calls, return every result, then resume
 * the managed Responses backend. Transcript fragments never trigger tools. */
export function withSalesVoiceToolLoop(connect:SidebandSocketFactory,execute:CommercialToolExecutor,
  report:(state:"RESULT_SENT"|"CONTINUED"|"SEND_FAILED")=>void=state=>console.info("[sales-voice] tool "+state),
):SidebandSocketFactory{
  return (url,options)=>{
    const socket=connect(url,options),states=new Map<string,State>(),seen=new Set<string>();
    let open=false,closed=false,backendActive=false,errorNotified=false,queue=Promise.resolve();
    const note=(state:"RESULT_SENT"|"CONTINUED"|"SEND_FAILED")=>{try{report(state);}catch{/* passive reporting */}};
    const send=(event:Record<string,unknown>)=>{
      if(!open||closed||typeof socket.send!=="function")return false;
      try{socket.send(JSON.stringify({...event,event_id:"sales_"+randomUUID()}));return true;}
      catch{note("SEND_FAILED");return false;}
    };
    socket.on("open",()=>{open=true;});
    socket.on("close",()=>{closed=true;states.clear();seen.clear();});
    socket.on("error",()=>{closed=true;states.clear();seen.clear();});
    socket.on("message",raw=>{
      if(!open||closed)return;
      // Parse and bind before enqueueing; retain only bounded protocol events.
      let envelope:any;
      try{
        const data=typeof raw==="string"?raw:Buffer.isBuffer(raw)?raw.toString("utf8"):null;
        if(data===null||Buffer.byteLength(data)>SALES_VOICE_SIDEBAND_MAX_MESSAGE_BYTES)return;
        envelope=JSON.parse(data);
        if(!envelope||typeof envelope!=="object")return;
        if("session_id" in envelope&&envelope.session_id!==url.split("/").at(-2))return;
        if(envelope.type==="error"){
          if(backendActive&&!errorNotified){
            errorNotified=true;backendActive=false;
            send({type:"session.instructions.append",delegation_id:null,content:
              "La consulta comercial del backend no pudo completarse. Responde ahora brevemente en el idioma elegido que no pudiste confirmar esa informacion y ofrece pin-ngo.com. No prometas volver a consultar, no inventes la respuesta ni dejes al interlocutor esperando.",
            });
          }
          return;
        }
        if(envelope.type!=="response.event"||!envelope.event||typeof envelope.event!=="object")return;
      }catch{return;}
      queue=queue.then(async()=>{
        if(closed)return;
        const event=envelope.event;
        const key=typeof envelope.delegation_id==="string"?envelope.delegation_id:"current";
        if(key.length>256)return;
        if(event.type==="response.created"){
          backendActive=true;errorNotified=false;
          if(states.size>=128&&!states.has(key))states.delete(states.keys().next().value!);
          states.set(key,{outputs:0,continued:false});return;
        }
        if(event.type==="response.output_item.done"&&event.item?.type==="function_call"){
          const item=event.item;
          if(typeof item.call_id!=="string"||!/^call_[A-Za-z0-9_-]{1,180}$/.test(item.call_id)
            ||typeof item.name!=="string"||typeof item.arguments!=="string"||seen.has(item.call_id))return;
          if(seen.size>=512)seen.delete(seen.values().next().value!);
          seen.add(item.call_id);
          let output:string;
          try{output=await execute(item.name,item.arguments);}catch{output=JSON.stringify({status:"UNAVAILABLE",code:"COMMERCIAL_TOOL_FAILED"});}
          if(closed)return;
          if(Buffer.byteLength(output)>24000)output=JSON.stringify({status:"UNAVAILABLE",code:"TOOL_OUTPUT_TOO_LARGE"});
          const state=states.get(key)??{outputs:0,continued:false};states.set(key,state);
          if(send({type:"response.item.create",item:{type:"function_call_output",call_id:item.call_id,output}})){
            state.outputs++;note("RESULT_SENT");
          }
        }
        if(event.type==="response.completed"){
          const state=states.get(key);
          if(state&&state.outputs>0&&!state.continued){
            state.continued=true;
            if(send({type:"response.create"}))note("CONTINUED");
          }else {states.delete(key);backendActive=false;}
        }
        if(event.type==="response.failed"||event.type==="response.incomplete"){states.delete(key);backendActive=false;}
      }).catch(()=>{/* read-only failures cannot close or control a phone call */});
    });
    return socket;
  };
}
