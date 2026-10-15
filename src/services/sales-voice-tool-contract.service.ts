import {salesVoiceProductFacts} from "./sales-voice-product-knowledge.service.js";
export const SALES_VOICE_COMMERCIAL_TOOLS=[
  {type:"function" as const,name:"get_pingo_product_information",
    description:"Consulta conocimiento comercial verificado del backend por tema: calendario, cancelaciones, pagos al anfitrion, identidad, daños, horarios y cambios de estadia, limpieza, mensajes OTA, Pin AI, incidencias, marca, equipo, dispositivos, onboarding y facturacion. overview devuelve un resumen y el indice de temas; consulta despues el tema especifico. Las condiciones no certifican activacion en cuentas privadas.",strict:true,
    parameters:{type:"object",properties:{topic:{type:"string",description:"Elige el tema especifico; payments es un resumen general. Cobros al anfitrion/onboarding de pagos = stripe_connect; operaciones de limpieza = cleaner_workflow; condiciones de cambios = reservation_changes. Indice: "+salesVoiceProductFacts.map(f=>f.id+": "+(f.titleEs??f.id)+" / "+(f.titleEn??f.id)).join("; "),enum:["overview",...salesVoiceProductFacts.map(f=>f.id)]},language:{type:"string",enum:["es","en"]}},required:["topic","language"],additionalProperties:false}},
  {type:"function" as const,name:"get_pingo_current_prices",
    description:"Consulta ahora los precios vigentes de plataforma y hardware en Stripe y las tarifas de complementos del backend. Usa esta herramienta si falta o vence el catalogo de la llamada.",strict:true,
    parameters:{type:"object",properties:{},required:[],additionalProperties:false}},
  {type:"function" as const,name:"search_pingo_official_website",
    description:"Lee y busca informacion publicada en el landing oficial https://pin-ngo.com/. Usa el backend para confirmar precios y capacidades si existen diferencias. No busca en otros sitios.",strict:true,
    parameters:{type:"object",properties:{query:{type:"string"}},required:["query"],additionalProperties:false}},
];
