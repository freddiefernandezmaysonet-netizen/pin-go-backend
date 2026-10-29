import { resolveChannexOperationalProvider } from "../services/ota-guest-external-messaging.policy.js";

export function guestAppVerificationChannel(stay: {
  source?: string | null; externalProvider?: string | null; externalId?: string | null; guestEmail?: string | null;
}): "CHANNEX" | "EMAIL" | null {
  if (resolveChannexOperationalProvider(stay)) return "CHANNEX";
  // Airbnb/Booking must never fall back to email when their booking mapping is missing.
  const source = String(stay.source ?? "").trim().toUpperCase().replace(/[.\s-]/g, "_");
  if (stay.externalProvider?.trim().toUpperCase() === "CHANNEX" &&
      ["AIRBNB", "AIR_BNB", "BOOKING_COM", "BOOKINGCOM"].includes(source)) return null;
  const email = stay.guestEmail?.trim() ?? "";
  return email.length <= 254 && /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(email) ? "EMAIL" : null;
}

export function guestAppVerificationText(code: string, language: string | null, channel: "CHANNEX" | "EMAIL") {
  if (!/^\d{6}$/.test(code)) throw Error("GUEST_APP_VERIFICATION_CODE_INVALID");
  const es = /^es/i.test(language ?? "");
  return es
    ? `Pin&Go Guest · Verificación de dispositivo\nTu código de verificación: ${code}\nVálido por 10 minutos. Escríbelo en la página donde solicitaste vincular la app. No es el código de la puerta. No lo compartas con nadie, incluido el host. Si no solicitaste activar un dispositivo, ignora este mensaje; no se le ha dado acceso.`
    : `Pin&Go Guest · Device verification\nYour verification code: ${code}\nValid for 10 minutes. Enter it on the page where you requested to link the app. This is not your door code. Do not share it with anyone, including your host. If you did not request to activate a device, ignore this message; access has not been granted.`;
}
