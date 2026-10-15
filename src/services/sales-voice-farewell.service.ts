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
export function withSalesVoiceFarewell(connect:SidebandSocketFactory,onFinish:(stillWanted:()=>boolean)=>Promise<unknown>,setTimer:Schedule=schedule,report:(state:string)=>void=state=>console.info("[sales-voice] farewell "+state)):SidebandSocketFactory{
  return(url,options)=>{
    const socket=connect(url,options),id=url.split("/").at(-2);
    let open=false,closed=false,requested=false,saidBye=false,sent=false,user="",assistant="",cancel:(()=>void)|undefined;
    let backend=false,generation=0,lastInputEnd:number|undefined,farewellStart:number|undefined,assistantSpoke=false;
    const noted=new Set<string>();
    const note=(state:string)=>{if(noted.has(state))return;noted.add(state);try{report(state);}catch{}};
    const stop=()=>{cancel?.();cancel=undefined;};
    const reset=()=>{stop();requested=false;saidBye=false;assistant="";farewellStart=undefined;generation++;};
    const arm=()=>{
      stop();if(!requested||!saidBye||backend||sent||closed)return;
      note("WAITING_FOR_QUIET");const epoch=generation;
      cancel=setTimer(()=>{
        cancel=undefined;
        const wanted=()=>open&&!closed&&!sent&&requested&&saidBye&&!backend&&generation===epoch;
        if(!wanted())return;
        // Mark once locally, while allowing the coordinator to recheck interruption.
        sent=true;
        note("HANGUP_REQUESTED");
        void onFinish(()=>open&&!closed&&requested&&saidBye&&!backend&&generation===epoch)
          .then(result=>note(typeof result==="string"&&/^[A-Z_]{1,60}$/.test(result)?result:"HANGUP_CALLBACK_COMPLETED"),()=>note("HANGUP_CALLBACK_FAILED"));
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
          const start=typeof e.start_ms==="number"&&Number.isFinite(e.start_ms)?e.start_ms:undefined;
          const end=typeof e.end_ms==="number"&&Number.isFinite(e.end_ms)?e.end_ms:undefined;
          // Reflected transcripts may arrive interleaved or late. A fragment
          // spoken before the farewell is not a new caller interruption.
          const delayed=saidBye&&end!==undefined&&farewellStart!==undefined&&end<=farewellStart;
          const newTurn=start!==undefined&&lastInputEnd!==undefined&&start-lastInputEnd>1200;
          if((saidBye&&!delayed)||newTurn||(assistantSpoke&&!requested&&start===undefined)){
            if(saidBye)note("CALLER_CONTINUED");user="";reset();
          }
          assistantSpoke=false;
          if(end!==undefined)lastInputEnd=Math.max(lastInputEnd??0,end);
          user=(user+e.delta).slice(-600);requested=ended(normalize(user));
          if(!requested)reset();else{note("CALLER_ENDING");arm();}
        }
        if(e.type==="session.output_transcript.delta"&&typeof e.delta==="string"){
          // Do not clear caller text: Live can backchannel mid-utterance.
          if(!requested){if(normalize(e.delta).length>8)assistantSpoke=true;return;}
          assistant=(assistant+e.delta).slice(-600);saidBye=farewell(normalize(assistant));
          if(saidBye){
            if(farewellStart===undefined&&typeof e.start_ms==="number")farewellStart=e.start_ms;
            note("ASSISTANT_FAREWELL");
          }
          arm();
        }
        if(e.type==="response.event"&&e.event?.type==="response.created"){backend=true;stop();}
        if(e.type==="response.event"&&["response.completed","response.failed","response.incomplete"].includes(e.event?.type)){backend=false;arm();}
        if(e.type==="session.output_audio.delta"&&requested&&saidBye&&typeof e.delta==="string"){
          // Live emits silent frames too. Only audible samples postpone closing.
          const audio=Buffer.from(e.delta,"base64");
          let energy=0;for(let i=0;i+1<audio.length;i+=2)energy+=audio.readInt16LE(i)**2;
          if(audio.length>=2&&Math.sqrt(energy/Math.floor(audio.length/2))>350)arm();
        }
      }catch{/* malformed observations never control the call */}
    });
    return socket;
  };
}
