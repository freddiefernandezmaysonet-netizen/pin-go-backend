import type {SidebandSocketFactory} from "./sales-voice-sideband-supervisor.service.js";
type Summary={inputSeen:boolean;outputSeen:boolean;outputBeforeInput:boolean;delegations:number;completed:number;failed:number;validationFailed:boolean};
/** Passive metadata only. Never records text, audio, identifiers, error messages or tool arguments. */
export function withSalesVoiceConversationDiagnostics(connect:SidebandSocketFactory,
  report:(value:Readonly<Summary>)=>void=value=>console.info("[sales-voice] conversation",value),
):SidebandSocketFactory{
  return (url,options)=>{
    const socket=connect(url,options);
    const summary:Summary={inputSeen:false,outputSeen:false,outputBeforeInput:false,delegations:0,completed:0,failed:0,validationFailed:false};
    let open=false,closed=false;
    const emit=()=>{try{report(Object.freeze({...summary}));}catch{/* no call-control effects */}};
    socket.on("open",()=>{open=true;});
    socket.on("message",raw=>{
      if(!open||closed)return;
      try{
        const data=typeof raw==="string"?raw:Buffer.isBuffer(raw)?raw.toString("utf8"):null;
        if(data===null||Buffer.byteLength(data)>16384)return;
        const event=JSON.parse(data);
        if(!event||typeof event!=="object"||Array.isArray(event))return;
        if("session_id" in event&&event.session_id!==url.split("/").at(-2))return;
        if(event.type==="session.input_transcript.delta"&&!summary.inputSeen){summary.inputSeen=true;emit();}
        if(event.type==="session.output_transcript.delta"&&!summary.outputSeen){
          summary.outputSeen=true;summary.outputBeforeInput=!summary.inputSeen;emit();
        }
        if(event.type==="session.delegation.created"&&summary.delegations<100){summary.delegations++;emit();}
        if(event.type==="response.event"&&event.event?.type==="response.completed"&&summary.completed<100){summary.completed++;emit();}
        if(event.type==="response.event"&&(event.event?.type==="response.failed"||event.event?.type==="response.incomplete")&&summary.failed<100){summary.failed++;emit();}
        if(event.type==="error"&&event.error?.code==="responses_validation_failed"&&!summary.validationFailed){summary.validationFailed=true;emit();}
      }catch{/* malformed or unsupported input cannot alter monitoring */ }
    });
    socket.on("close",()=>{if(!closed){closed=true;emit();}});
    return socket;
  };
}
