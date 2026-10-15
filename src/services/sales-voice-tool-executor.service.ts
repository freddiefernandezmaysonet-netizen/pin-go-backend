import {salesVoiceProductFacts,salesVoiceCoreTopicIds,SALES_VOICE_PRODUCT_KNOWLEDGE_VERSION} from "./sales-voice-product-knowledge.service.js";
import {readSalesVoicePricing,renderSalesVoicePricing,type PriceReader} from "./sales-voice-pricing.service.js";
type Env=Readonly<Record<string,string|undefined>>;
export type CommercialToolExecutor=(name:string,argumentsJson:string)=>Promise<string>;
type PublicFetch=(url:string,init:RequestInit)=>Promise<Response>;
const unavailable=(code:string)=>JSON.stringify({status:"UNAVAILABLE",code});
const normalize=(s:string)=>s.normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase();
async function boundedText(response:Response):Promise<string>{
  const reader=response.body?.getReader();if(!reader)throw Error("EMPTY_BODY");
  const decoder=new TextDecoder();let bytes=0,text="";
  while(true){
    const part=await reader.read();if(part.done)break;
    bytes+=part.value.byteLength;
    if(bytes>1024*1024){await reader.cancel();throw Error("BODY_TOO_LARGE");}
    text+=decoder.decode(part.value,{stream:true});
  }
  return text+decoder.decode();
}
function websiteResult(query:string,text:string,source:string,extra:Record<string,unknown>={}):string{
  const words=normalize(query).split(/[^a-z0-9]+/).filter(w=>w.length>2).slice(0,20);
  const chunks=text.match(/.{1,1200}/g)??[];
  const ranked=chunks.map((text,index)=>({text,index,score:words.reduce((n,w)=>n+(normalize(text).includes(w)?1:0),0)}))
    .sort((a,b)=>b.score-a.score||a.index-b.index).slice(0,6).sort((a,b)=>a.index-b.index);
  return JSON.stringify({status:"AVAILABLE",source,checkedAt:new Date().toISOString(),...extra,
    content:ranked.map(c=>c.text).join("\n"),partial:ranked.length<chunks.length,
    authority:"Public website text; verify commercial prices and capabilities with backend tools."});
}

async function website(query:string,fetchPage:PublicFetch):Promise<string>{
  try{
    const signal=AbortSignal.timeout(4000);
    const feed=await fetchPage("https://www.pin-ngo.com/pingo-commercial-knowledge.json",{redirect:"manual",signal,headers:{Accept:"application/json"}});
    if(feed.ok&&feed.headers.get("content-type")?.includes("application/json")){
      const data=JSON.parse(await boundedText(feed));
      if(data?.schemaVersion!==1||data.source!=="https://www.pin-ngo.com/"
        ||typeof data.contentVersion!=="string"||!/^[a-f0-9]{64}$/.test(data.contentVersion)
        ||typeof data.languages?.es!=="string"||typeof data.languages?.en!=="string"
        ||data.languages.es.length<150||data.languages.en.length<150)
        return unavailable("WEBSITE_FEED_INVALID");
      return websiteResult(query,"ES: "+data.languages.es+"\nEN: "+data.languages.en,data.source,{contentVersion:data.contentVersion,builtAt:data.builtAt});
    }
    await feed.body?.cancel();
    let response=await fetchPage("https://pin-ngo.com/",{redirect:"manual",signal,headers:{Accept:"text/html"}});
    let source="https://pin-ngo.com/";
    if([301,302,307,308].includes(response.status)){
      const next=new URL(response.headers.get("location")??"",source);
      if(next.href!=="https://www.pin-ngo.com/")return unavailable("WEBSITE_REDIRECT_NOT_ALLOWED");
      await response.body?.cancel();source=next.href;
      response=await fetchPage(source,{redirect:"manual",signal,headers:{Accept:"text/html"}});
    }
    if(!response.ok||!response.headers.get("content-type")?.includes("text/html"))return unavailable("WEBSITE_NOT_READABLE");
    const html=await boundedText(response);
    const text=html.replace(/<!--[\s\S]*?-->/g," ").replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi," ")
      .replace(/<[^>]*>/g," ").replace(/&nbsp;/gi," ").replace(/&amp;/gi,"&").replace(/&quot;/gi,'"')
      .replace(/&#39;|&apos;/gi,"'").replace(/&lt;/gi,"<").replace(/&gt;/gi,">").replace(/\s+/g," ").trim();
    if(text.length<150)return unavailable("WEBSITE_TEXT_UNAVAILABLE");
    return websiteResult(query,text,source);
  }catch{return unavailable("WEBSITE_REQUEST_FAILED");}
}

/** Only public product facts, live configured prices and a fixed public website.
 * No arbitrary URLs, SQL, tenant data or mutating service are exposed. */
export function createSalesVoiceToolExecutor(env:Env,readPrice:PriceReader,fetchPage:PublicFetch=fetch):CommercialToolExecutor{
  return async(name,raw)=>{
    if(typeof raw!=="string"||Buffer.byteLength(raw)>2048)return unavailable("INVALID_TOOL_ARGUMENTS");
    let args:Record<string,unknown>;
    try{args=JSON.parse(raw);if(!args||typeof args!=="object"||Array.isArray(args))throw Error();}
    catch{return unavailable("INVALID_TOOL_ARGUMENTS");}
    if(name==="get_pingo_product_information"){
      if(Object.keys(args).sort().join(",")!=="language,topic"||!["es","en"].includes(String(args.language))
        ||typeof args.topic!=="string")return unavailable("INVALID_TOOL_ARGUMENTS");
      const facts=args.topic==="overview"?salesVoiceProductFacts.filter(f=>salesVoiceCoreTopicIds.includes(f.id)):salesVoiceProductFacts.filter(f=>f.id===args.topic);
      if(!facts.length)return unavailable("UNKNOWN_PRODUCT_TOPIC");
      return JSON.stringify({status:"AVAILABLE",source:"Pin&Go commercial backend",version:SALES_VOICE_PRODUCT_KNOWLEDGE_VERSION,
        overview:args.language==="es"?"Pin&Go es una plataforma integral para administrar propiedades vacacionales.":"Pin&Go is an all-in-one vacation rental property management platform.",
        ...(args.topic==="overview"?{availableTopics:salesVoiceProductFacts.map(f=>({topic:f.id,title:args.language==="es"?(f.titleEs??f.id):(f.titleEn??f.id)}))}:{}),
        facts:facts.map(f=>({topic:f.id,information:args.language==="es"?f.es:f.en,conditions:f.limit}))});
    }
    if(name==="get_pingo_current_prices"){
      if(Object.keys(args).length)return unavailable("INVALID_TOOL_ARGUMENTS");
      try{return JSON.stringify({status:"AVAILABLE",source:"Pin&Go backend and Stripe",catalog:renderSalesVoicePricing(await readSalesVoicePricing(env,readPrice))});}
      catch{return unavailable("PRICING_REQUEST_FAILED");}
    }
    if(name==="search_pingo_official_website"){
      if(Object.keys(args).join(",")!=="query"||typeof args.query!=="string"||args.query.trim().length<2||args.query.length>300)
        return unavailable("INVALID_TOOL_ARGUMENTS");
      return website(args.query,fetchPage);
    }
    return unavailable("UNKNOWN_COMMERCIAL_TOOL");
  };
}
