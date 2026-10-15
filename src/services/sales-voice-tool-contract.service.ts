import {salesVoiceProductFacts} from "./sales-voice-product-knowledge.service.js";
export const SALES_VOICE_COMMERCIAL_TOOLS=[
  {type:"function" as const,name:"get_pingo_product_information",
    description:"Consulta informacion comercial verificada del backend de Pin&Go: producto, funciones, requisitos y registro. No accede a cuentas privadas.",strict:true,
    parameters:{type:"object",properties:{topic:{type:"string",enum:["overview",...salesVoiceProductFacts.map(f=>f.id)]},language:{type:"string",enum:["es","en"]}},required:["topic","language"],additionalProperties:false}},
  {type:"function" as const,name:"get_pingo_current_prices",
    description:"Consulta ahora los precios vigentes de plataforma y hardware en Stripe y las tarifas de complementos del backend. Usa esta herramienta si falta o vence el catalogo de la llamada.",strict:true,
    parameters:{type:"object",properties:{},required:[],additionalProperties:false}},
  {type:"function" as const,name:"search_pingo_official_website",
    description:"Lee y busca informacion publicada en el landing oficial https://pin-ngo.com/. Usa el backend para confirmar precios y capacidades si existen diferencias. No busca en otros sitios.",strict:true,
    parameters:{type:"object",properties:{query:{type:"string"}},required:["query"],additionalProperties:false}},
];
