import type {SidebandSocketFactory} from "./sales-voice-sideband-supervisor.service.js";
import {SALES_VOICE_SIDEBAND_MAX_MESSAGE_BYTES} from "./sales-voice-protocol-limits.service.js";
const normalize=(s:string)=>s.normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/[’']/g,"'").replace(/\[[^\]]*\]/g," ").replace(/\s+/g," ").trim();
const ended=(s:string)=>!/[?¿]/.test(s)&&! /\b(pero|antes|otra|otro|espera|no cuelgues|but|wait|another|don't hang)\b/.test(s)
  && /\b(eso es todo|seria todo|nada mas|hasta luego|adios|puedes colgar|that's all|that is all|nothing else|goodbye|bye|you can hang up)\b/.test(s);
const farewell=(s:string)=>!/[?¿]/.test(s)&&/\b(hasta luego|adios|buen dia|buena noche|buenas noches|gracias por llamar|gracias por comunicarte|goodbye|bye|have a (great|good|nice)|thanks for calling|thank you for calling)\b/.test(s);
type Schedule=(task:()=>void,delay:number)=>()=>void;
const schedule:Schedule=(task,delay)=>{const timer=setTimeout(task,delay);timer.unref?.();return()=>clearTimeout(timer);};
/** A paired explicit caller ending and assistant farewell, followed by quiet
 * audio. Transcripts are ephemeral and bounded; a thank-you alone never hangs up.
 * The coordinator retains ownership and the durable one-request hangup fence. */
export function withSalesVoiceFarewell(connect:SidebandSocketFactory,onFinish:(stillWanted:()=>boolean)=>Promise<unknown>,setTimer:Schedule=schedule):SidebandSocketFactory{
  return(url,options)=>{
    const socket=connect(url,options),id=url.split("/").at(-2);
    let open=false,closed=false,requested=false,saidBye=false,sent=false,user="",assistant="",cancel:(()=>void)|undefined;
    let backend=false,generation=0;
    const stop=()=>{cancel?.();cancel=undefined;};
    const reset=()=>{stop();requested=false;saidBye=false;assistant="";generation++;};
    const arm=()=>{
      stop();if(!requested||!saidBye||backend||sent||closed)return;
      const epoch=generation;
      cancel=setTimer(()=>{
        cancel=undefined;
        const wanted=()=>open&&!closed&&!sent&&requested&&saidBye&&!backend&&generation===epoch;
        if(!wanted())return;
        // Mark once locally, while allowing the coordinator to recheck interruption.
        sent=true;
        void onFinish(()=>open&&!closed&&requested&&saidBye&&!backend&&generation===epoch).catch(()=>{});
      },2500);
    };
    socket.on("open",()=>{open=true;});
    socket.on("close",()=>{closed=true;stop();});socket.on("error",()=>{closed=true;stop();});
    socket.on("message",raw=>{
      if(!open||closed)return;
      try{
        const text=typeof raw==="string"?raw:Buffer.isBuffer(raw)?raw.toString("utf8"):null;
        if(text===null||Buffer.byteLength(text)>SALES_VOICE_SIDEBAND_MAX_MESSAGE_BYTES)return;
        const e=JSON.parse(text);if(!e||typeof e!=="object"||("session_id" in e&&e.session_id!==id))return;
        if(e.type==="session.closed"){closed=true;stop();return;}
        if(e.type==="session.input_transcript.delta"&&typeof e.delta==="string"){
          if(saidBye){user="";reset();} // caller interrupts/reopens the conversation
          user=(user+e.delta).slice(-600);requested=ended(normalize(user));if(!requested)reset();else arm();
        }
        if(e.type==="session.output_transcript.delta"&&typeof e.delta==="string"){
          if(!requested){user="";return;}
          assistant=(assistant+e.delta).slice(-600);saidBye=farewell(normalize(assistant));arm();
        }
        if(e.type==="response.event"&&e.event?.type==="response.created"){backend=true;stop();}
        if(e.type==="response.event"&&["response.completed","response.failed","response.incomplete"].includes(e.event?.type)){backend=false;arm();}
        if(e.type==="session.output_audio.delta"&&requested&&saidBye&&typeof e.delta==="string"){
          // Live emits silent frames too. Only audible samples postpone closing.
          const audio=Buffer.from(e.delta,"base64");
          for(let i=0;i+1<audio.length;i+=2)if(Math.abs(audio.readInt16LE(i))>350){arm();break;}
        }
      }catch{/* malformed observations never control the call */}
    });
    return socket;
  };
}
