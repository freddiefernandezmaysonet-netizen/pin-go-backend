import {salesVoiceAnswerBackend,SALES_VOICE_MANAGED_ANSWER_POLICY,SALES_VOICE_CONVERSATION_INSTRUCTIONS} from "./sales-voice-answer-backend.service.js";
import {salesVoiceAddonPrices} from "./sales-voice-addon-pricing.service.js";
import {assertMonthlyPrice,haasMonthlyAmounts} from "./signup-pricing.service.js";
import type {ProviderHTTP} from "./sales-voice-live-admission.service.js";
type Env=Readonly<Record<string,string|undefined>>;
type Offer=Readonly<{label:string;key:string;amount:number;interval:"month"|"year";term?:number}>;
export type PriceReader=(id:string)=>Promise<unknown>;
const offers:readonly Offer[]=[
  {label:"Plataforma mensual / Monthly platform",key:"STRIPE_PRICE_PLATFORM_MONTHLY",amount:3999,interval:"month"},
  {label:"Plataforma anual / Annual platform",key:"STRIPE_PRICE_PLATFORM_YEARLY",amount:39990,interval:"year"},
  ...Object.entries(haasMonthlyAmounts).flatMap(([model,terms])=>([12,24] as const).map(term=>({
    label:"HaaS "+model+" "+term+" meses / months",key:`STRIPE_PRICE_HAAS_${model.toUpperCase()}_${term}_MONTHLY`,
    amount:terms[term],interval:"month" as const,term,
  }))),
];
type PriceState="MISSING"|"INVALID"|"VERIFIED"|"FAILED"|"TIMEOUT"|"ABORTED";
type PriceDiagnostic=Readonly<{monthly:PriceState;yearly:PriceState;verified:number;unavailable:number}>;
export type PricingSnapshot=Readonly<{checkedAt:number;expiresAt:number;lines:readonly string[];addonLines?:readonly string[]}>;
/** Fresh checkout-compatible prices; slow unrelated offers cannot erase completed validations. */
export async function readSalesVoicePricing(env:Env,read:PriceReader,options:{
  now?:()=>number;timeoutMs?:number;signal?:AbortSignal;report?:(entry:PriceDiagnostic)=>void;
}={}):Promise<PricingSnapshot>{
  const now=options.now??Date.now,checkedAt=now(),timeoutMs=options.timeoutMs??1250;
  if(!Number.isFinite(checkedAt)||!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>1500)
    throw new Error("INVALID_SALES_PRICING_LIMIT");
  const unavailable=offers.map(o=>o.label+": UNAVAILABLE.");
  const lines=[...unavailable],states:PriceState[]=offers.map(()=>"TIMEOUT");
  if(options.signal?.aborted)return Object.freeze({checkedAt,expiresAt:checkedAt,lines:Object.freeze(unavailable)});
  let sealed=false;
  const complete=(i:number,state:PriceState,text=unavailable[i])=>{
    if(!sealed){states[i]=state;lines[i]=text;}
  };
  const work=Promise.all(offers.map(async(o,i)=>{
    const id=env[o.key]?.trim();
    if(!id||!/^price_[A-Za-z0-9_]+$/.test(id)){complete(i,"MISSING");return;}
    let price:any;
    try{price=await read(id);}catch{complete(i,"FAILED");return;}
    try{
      if(price?.object!=="price"||price.id!==id||typeof price.livemode!=="boolean"
        ||(env.NODE_ENV==="production"&&!price.livemode)
        ||!Number.isSafeInteger(price.unit_amount)||price.unit_amount<=0)throw new Error("INVALID_PRICE");
      assertMonthlyPrice(price,o.amount,o.interval);
      complete(i,"VERIFIED",o.label+": VERIFIED USD "+(price.unit_amount/100).toFixed(2)
        +(o.interval==="year"?" por año / per year":" por mes / per month")
        +(o.term?"; 1 cerradura / lock; plazo / term "+o.term+" meses / months":" por cerradura / per lock")
        +"; impuestos adicionales / taxes extra.");
    }catch{complete(i,"INVALID");}
  }));
  let timer:ReturnType<typeof setTimeout>|undefined;
  let abort:()=>void=()=>{};
  const fallback=new Promise<void>(resolve=>{
    timer=setTimeout(resolve,timeoutMs);
    abort=()=>resolve();
    options.signal?.addEventListener("abort",abort,{once:true});
    if(options.signal?.aborted)abort();
  });
  try{await Promise.race([work,fallback]);}
  finally{sealed=true;if(timer)clearTimeout(timer);options.signal?.removeEventListener("abort",abort);}
  if(options.signal?.aborted){for(let i=0;i<lines.length;i++){lines[i]=unavailable[i];states[i]="ABORTED";}}
  const verified=states.filter(s=>s==="VERIFIED").length;
  try{(options.report??(entry=>console.info("[sales-voice] pricing",entry)))(
    Object.freeze({monthly:states[0],yearly:states[1],verified,unavailable:offers.length-verified}));}catch{/* telemetry never changes call outcome */}
  return Object.freeze({checkedAt,expiresAt:checkedAt+300000,lines:Object.freeze([...lines]),addonLines:salesVoiceAddonPrices(env)});
}
export function renderSalesVoicePricing(snapshot:PricingSnapshot):string{
  return [
    "Catalogo de precios verificado para esta llamada / Verified call pricing.",
    "Consultado / checked: "+new Date(snapshot.checkedAt).toISOString()+". Valido hasta / valid until: "+new Date(snapshot.expiresAt).toISOString()+".",
    ...snapshot.lines,
    ...(snapshot.addonLines??[]),
    "Cotiza solamente ofertas VERIFIED y dentro de su vigencia; UNAVAILABLE no confirma ningun importe. Si falta o vence el dato, dilo inmediatamente y ofrece app.pin-ngo.com/signup; nunca prometas verificar despues.",
    "Responde en el idioma elegido. Explica frecuencia, precio por cerradura y plazo antes de recomendar. Para varias cerraduras de plataforma puedes calcular precio base por cantidad, siempre antes de impuestos. El anual se cobra por año, no mensualmente.",
    "HaaS corresponde a una cerradura y mensualidad del paquete con hardware; no prometas stock, instalacion ni inclusiones adicionales. Para complementos usa solo sus tarifas verificadas y condiciones separadas. No cotices descuentos, impuestos exactos ni totales finales.",
  ].join("\n");
}
/** Called only by the existing one-shot admitted accept, under its original total deadline. */
export function withSalesVoicePricing(transport:ProviderHTTP,env:Env,read:PriceReader):ProviderHTTP{
  return async(url,request)=>{
    if(!/^https:\/\/api\.openai\.com\/v1\/live\/sessions\/live_[A-Za-z0-9_-]{1,123}\/accept$/.test(url)
      ||request.method!=="POST")throw new Error("INVALID_SALES_PRICING_ENDPOINT");
    if(request.signal.aborted)throw new Error("SALES_ACCEPT_ABORTED");
    const payload=JSON.parse(request.body);
    if(payload?.session?.type!=="live"||typeof payload.session.instructions!=="string")
      throw new Error("INVALID_SALES_PRICING_SESSION");
    const snapshot=await readSalesVoicePricing(env,read,{signal:request.signal});
    if(request.signal.aborted)throw new Error("SALES_ACCEPT_ABORTED");
    const verifiedContext=payload.session.instructions+"\n"+renderSalesVoicePricing(snapshot);
    payload.session.delegation=salesVoiceAnswerBackend(verifiedContext);
    payload.session.instructions=SALES_VOICE_CONVERSATION_INSTRUCTIONS+"\n"+SALES_VOICE_MANAGED_ANSWER_POLICY;
    return transport(url,{...request,body:JSON.stringify(payload)});
  };
}
