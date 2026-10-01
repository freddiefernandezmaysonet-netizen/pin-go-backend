import { resolveStaffLanguage, type StaffLanguage } from "./staff-language.service.js";

function safe(value: unknown,maxLength:number){return String(value??"").normalize("NFKD").replace(/[\u0300-\u036f]/g,"").replace(/[“”]/g,'"').replace(/[‘’]/g,"'").replace(/[–—]/g,"-").replace(/[^A-Za-z0-9 .,&'()#*+/:;?%-]/g,"").replace(/\s+/g," ").trim().slice(0,maxLength);}

export function buildCleaningReadySmsBody(input:{propertyName:string;roomName:string;start:string;end:string;language?:StaffLanguage;}){
 const language=resolveStaffLanguage(input.language);
 const propertyName=safe(input.propertyName,24)||(language==="es"?"Propiedad":"Property");
 const roomName=safe(input.roomName,16)||"N/A"; const start=safe(input.start,24)||(language==="es"?"inicio":"start"); const end=safe(input.end,24)||(language==="es"?"fin":"end");
 return language==="es"
  ? `Pin&Go limpieza lista. Prop: ${propertyName}. Unidad: ${roomName}. Ventana: ${start}-${end}.`
  : `Pin&Go cleaning ready. Prop: ${propertyName}. Unit: ${roomName}. Window: ${start}-${end}.`;
}
