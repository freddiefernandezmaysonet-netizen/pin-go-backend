import { resolveStaffLanguage, type StaffLanguage } from "./staff-language.service.js";

function safe(value: unknown, maxLength: number) {
  return String(value ?? "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/[–—]/g, "-").replace(/[^A-Za-z0-9 .,&'()#*+/:;?%-]/g, "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

export function buildCleaningConfirmationSmsBody(input: {
  propertyName: string; roomName: string; checkOutText: string; confirmUrl: string; language?: StaffLanguage;
}) {
  const language=resolveStaffLanguage(input.language);
  const propertyName=safe(input.propertyName,24)||(language==="es"?"propiedad":"property");
  const roomName=safe(input.roomName,16)||"N/A";
  const checkOutText=safe(input.checkOutText,24)||(language==="es"?"salida":"checkout");
  const confirmUrl=String(input.confirmUrl??"").trim();
  return language==="es"
    ? `Pin&Go limpieza. Propiedad: ${propertyName}. Unidad: ${roomName}. Salida: ${checkOutText}. Confirma: ${confirmUrl}`
    : `Pin&Go cleaning. Property: ${propertyName}. Unit: ${roomName}. Check-out: ${checkOutText}. Confirm: ${confirmUrl}`;
}
