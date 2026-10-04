import { createHash } from "node:crypto";

export type AirbnbCommunicationType = "PRECHECKIN" | "GUEST_ACCESS_PASSCODE" | "CHECKOUT";
export type AirbnbScope = {
  id: string;
  source?: string | null;
  externalProvider?: string | null;
  externalId?: string | null;
  propertyId: string;
  organizationId: string;
};

/** Activation is deliberately exact: no wildcard or accidental all-tenant rollout. */
export function ownsAirbnbCommunication(scope: AirbnbScope, env: NodeJS.ProcessEnv): boolean {
  const ids = (key: string) => (env[key] ?? "").split(",").map(s => s.trim()).filter(Boolean);
  return env.CHANNEX_AIRBNB_ACCESS_ENABLED === "true" &&
    scope.source?.trim().toLowerCase() === "airbnb" &&
    scope.externalProvider?.trim().toUpperCase() === "CHANNEX" &&
    ids("CHANNEX_AIRBNB_ACCESS_ORGANIZATION_IDS").includes(scope.organizationId) &&
    ids("CHANNEX_AIRBNB_ACCESS_PROPERTY_IDS").includes(scope.propertyId) &&
    ids("CHANNEX_AIRBNB_ACCESS_RESERVATION_IDS").includes(scope.id);
}

export function airbnbDeliveryId(input: AirbnbScope & {
  type: AirbnbCommunicationType;
  checkIn: Date;
  checkOut: Date;
  accessGrantId?: string | null;
  accessCodeHash?: string | null;
}): string {
  return "abcomm_" + createHash("sha256").update(JSON.stringify([
    input.organizationId, input.propertyId, input.id, input.externalId,
    input.type, input.checkIn.toISOString(), input.checkOut.toISOString(),
    input.type === "GUEST_ACCESS_PASSCODE" ? input.accessGrantId : null,
    input.type === "GUEST_ACCESS_PASSCODE" ? input.accessCodeHash : null,
  ])).digest("hex");
}

export function buildAirbnbAccessText(input: {
  type: AirbnbCommunicationType; propertyName: string; language: string | null;
  timezone: string; checkIn: Date; checkOut: Date;
  code?: string; unlockKey?: string; address?: string | null; arrivalLocation?: string;
}): string {
  const es = input.language?.toLowerCase().startsWith("es");
  const format = new Intl.DateTimeFormat(es ? "es-PR" : "en-US", {
    timeZone: input.timezone, dateStyle: "medium", timeStyle: "short",
  });
  const start = format.format(input.checkIn), end = format.format(input.checkOut);
  const location = input.arrivalLocation ? `\n${input.arrivalLocation}` : "";
  if (input.type === "GUEST_ACCESS_PASSCODE") {
    if (!input.code?.trim()) throw new Error("AIRBNB_ACCESS_CODE_MISSING");
    return es
      ? `Pin&Go · ${input.propertyName}${location}\nTu código de acceso: ${input.code}\nVálido desde ${start} hasta ${end} (${input.timezone}).\nIngresa el código en el teclado y presiona ${input.unlockKey || "#"}. No compartas este código.`
      : `Pin&Go · ${input.propertyName}${location}\nYour access code: ${input.code}\nValid from ${start} until ${end} (${input.timezone}).\nEnter the code on the keypad and press ${input.unlockKey || "#"}. Do not share this code.`;
  }
  if (input.type === "CHECKOUT") return es
    ? `Pin&Go · ${input.propertyName}${location}\nTu horario de check-out es ${end} (${input.timezone}). Cierra puertas y ventanas y apaga luces y aire acondicionado al salir. Gracias por tu estadía.`
    : `Pin&Go · ${input.propertyName}${location}\nYour check-out time is ${end} (${input.timezone}). Close doors and windows and turn off lights and air conditioning when leaving. Thank you for staying.`;
  return (es
    ? `Pin&Go · ${input.propertyName}${location}\nTu check-in comienza ${start} (${input.timezone}). Recibirás el código de acceso por esta conversación cuando esté listo.`
    : `Pin&Go · ${input.propertyName}${location}\nYour check-in starts ${start} (${input.timezone}). Your access code will be sent in this conversation when ready.`) +
    (input.address?.trim() ? `\n${es ? "Dirección" : "Address"}: ${input.address.trim()}` : "");
}
