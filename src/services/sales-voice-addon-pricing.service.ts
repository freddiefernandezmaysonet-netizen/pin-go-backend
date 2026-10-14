import {pinAIBillingTerms} from "../pin-ai/billing-terms.js";
import {identityCheckBillingTerms} from "./identity-check-billing-consent.js";
type Env=Readonly<Record<string,string|undefined>>;
/** Existing authoritative terms only: no DB, provider call, consent change or billing mutation. */
export function salesVoiceAddonPrices(env:Env):readonly string[]{
  const terms=pinAIBillingTerms(env);
  const pinAI="Pin AI para huespedes / Guest Pin AI: VERIFIED USD "+(terms.amountCents/100).toFixed(2)
    +" por reserva / per reservation, una vez por reserva / once per reservation. Requiere activacion y aceptacion de los terminos aplicables; pueden existir exenciones. No se cobra por cerradura ni por mensaje. No confirma activacion ni cargos de una cuenta concreta.";
  let identity="Verificacion de identidad / Identity verification: UNAVAILABLE.";
  try{
    // Do not silently round malformed precision or blank configuration into a quote.
    const configured=env.DIRECT_BOOKING_PROTECTION_FEE_AMOUNT;
    if(configured!==undefined&&!/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,2})?$/.test(configured.trim()))
      throw new Error("INVALID_QUOTE_CONFIGURATION");
    const fee=identityCheckBillingTerms(env);
    if(!Number.isSafeInteger(fee.amountCents)||fee.amountCents<0)throw new Error("INVALID_QUOTE_AMOUNT");
    identity="Verificacion de identidad / Identity verification: VERIFIED tarifa configurada / configured fee USD "
      +(fee.amountCents/100).toFixed(2)
      +" para una reserva directa cuando se requiere verificacion / for a direct booking requiring verification."
      +" Requiere consentimiento de facturacion del anfitrion y las condiciones aplicables. Se deduce de los ingresos del anfitrion como componente de la comision, sujeto al limite del pago disponible; no es un cargo por cada mensaje, intento de verificacion o cerradura. No generalices esta tarifa a todas las reservas OTA ni confirmes el cargo final sin la reserva.";
  }catch{/* No raw configuration or error in model context. */}
  return Object.freeze([
    pinAI,identity,
    "Estos importes son tarifas de los terminos/configuracion comercial del backend, no precios de suscripcion recuperados de Stripe. Explica solo la tarifa y condiciones de un complemento cuando lo pregunten. No sumes estos cargos por uso a una mensualidad fija ni inventes impuestos, descuentos, disponibilidad o un total de factura. No cambies consentimientos, activaciones ni cobros.",
  ]);
}
