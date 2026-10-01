import { resolveStaffLanguage, type StaffLanguage } from "./staff-language.service.js";

export type CleaningFollowupDeliveryKind = "START_REMINDER" | "COMPLETION_REMINDER";

export function buildCleanerFollowupSms(input: Readonly<{kind:CleaningFollowupDeliveryKind;propertyName:string;actionUrl:string;language?:StaffLanguage;}>):string{
 const language=resolveStaffLanguage(input.language);
 const property=input.propertyName.replace(/\s+/g," ").trim().slice(0,40)||(language==="es"?"propiedad":"property");
 const url=input.actionUrl.trim(); if(!/^https:\/\//i.test(url)) throw new Error("CLEANING_FOLLOWUP_ACTION_URL_REQUIRED");
 if(input.kind==="START_REMINDER"){
  return language==="es"
   ? `Recordatorio Pin&Go: la limpieza en ${property} no se ha marcado como iniciada. Si ya comenzaste, confirma aqui; de lo contrario informa la demora: ${url}`
   : `Pin&Go reminder: cleaning at ${property} has not been marked started. If you already started, confirm here; otherwise report the delay: ${url}`;
 }
 return language==="es"
  ? `Recordatorio Pin&Go: la limpieza en ${property} llego a la hora comprometida y no se ha marcado como terminada. Confirma que terminaste o actualiza tu estado: ${url}`
  : `Pin&Go reminder: cleaning at ${property} has reached its committed completion time and is not marked finished. Confirm completion or update your status: ${url}`;
}
