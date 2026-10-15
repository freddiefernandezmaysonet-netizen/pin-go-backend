import {salesVoiceDetailedKnowledge} from "./sales-voice-detailed-knowledge.service.js";
/** Reviewed product facts, separate from call control. No DB, env or provider
 * access. Provenance records implementation evidence, not a tenant's activation.
 * Pricing requires a validated per-call snapshot; executable sales tools remain separate.
 */
export const SALES_VOICE_PRODUCT_KNOWLEDGE_VERSION="20261015-v2";
export const SALES_VOICE_PRODUCT_KNOWLEDGE_SOURCE_COMMIT="ed3e17cb492ccf23830c39daef94d6cf784a2ac6";
type Fact=Readonly<{id:string;titleEs?:string;titleEn?:string;es:string;en:string;limit:string;sources:readonly string[]}>;
const reviewedFacts:Fact[]=[
  {
    "id": "direct_booking",
    "es": "Pin&Go SI cuenta con Direct Booking o reservas directas. Los huespedes pueden consultar disponibilidad y reservar en linea las propiedades publicadas, con checkout de pago mediante Stripe segun la configuracion de la propiedad.",
    "en": "Pin&Go offers Direct Booking: guests can check availability and book published properties online, with Stripe checkout according to the property's configuration.",
    "limit": "La propiedad debe estar publicada y configurada para recibir reservas y pagos. Explicar esta funcion no significa que el agente haya consultado disponibilidad o creado una reserva.",
    "sources": [
      "src/routes/public-booking.routes.ts",
      "src/server.ts"
    ]
  },
  {
    "id": "payments",
    "es": "Pin&Go integra pagos de reservas directas mediante Stripe, con reglas de cancelacion y gestion de solicitudes desde el portal de la reserva.",
    "en": "Pin&Go integrates Stripe payments for direct bookings, with cancellation rules and requests managed through the reservation portal.",
    "limit": "Cancelaciones, reembolsos, cargos y pagos dependen de la politica y configuracion aplicables; no garantices un reembolso, una liquidacion ni una accion por telefono.",
    "sources": [
      "src/routes/public-booking.routes.ts"
    ]
  },
  {
    "id": "smart_access",
    "es": "Pin&Go integra cerraduras TTLock y acceso mediante codigos con vigencia y tarjetas NFC, segun el equipo y la configuracion.",
    "en": "Pin&Go integrates TTLock locks and time-bound passcodes or NFC cards, depending on the equipment and configuration.",
    "limit": "No prometas compatibilidad con cualquier cerradura, acceso sin requisitos tecnicos ni apertura remota realizada por este agente.",
    "sources": [
      "src/services/access.service.ts",
      "src/routes/nfc.sync.routes.ts",
      "src/routes/org.ttlock.connect.v2.router.ts"
    ]
  },
  {
    "id": "cleaning",
    "es": "Pin&Go permite coordinar asignaciones y confirmaciones de limpieza y usar listas de tareas por propiedad.",
    "en": "Pin&Go supports cleaning assignments, availability confirmations and property-specific checklists.",
    "limit": "Requiere configurar personal, tareas y reglas. No afirmes que se ha contratado, asignado o contactado personal durante esta llamada.",
    "sources": [
      "src/routes/cleaning.routes.ts",
      "src/services/cleaning-confirmation.service.ts",
      "src/routes/cleaning-checklist.routes.ts"
    ]
  },
  {
    "id": "rate_rules",
    "es": "Pin&Go tiene reglas de tarifas para reservas directas: temporadas, feriados, ocupacion, anticipacion y fines de semana, con limites minimo y maximo segun la configuracion.",
    "en": "Pin&Go supports direct-booking rate rules for seasons, holidays, occupancy, lead time and weekends, with configured minimum and maximum limits.",
    "limit": "Las reglas deben estar configuradas y habilitadas. No prometas precios de mercado en vivo, aumento de ingresos ni sincronizacion activa en una propiedad concreta.",
    "sources": [
      "src/services/direct-booking-pricing.service.ts"
    ]
  },
  {
    "id": "distribution",
    "es": "Pin&Go integra un centro de conexiones de distribucion con Channex para gestionar el estado y la configuracion de los canales de una propiedad.",
    "en": "Pin&Go integrates a Channex distribution connection center to manage a property's channel configuration and connection status.",
    "limit": "La disponibilidad y activacion dependen del canal y la propiedad. No declares todos los canales conectados ni confirmes una conexion o sincronizacion concreta sin evidencia actual.",
    "sources": [
      "src/routes/dashboard.distribution-connection-center.route.ts",
      "src/server.ts"
    ]
  },
  {
    "id": "guest_pin_ai",
    "es": "Pin AI para huespedes puede responder con contexto de la propiedad y la reserva, acceso, limpieza y politicas, segun su activacion y las funciones disponibles.",
    "en": "Guest Pin AI can answer using property and reservation context, access, cleaning and policy information, depending on activation and available capabilities.",
    "limit": "Pin AI para huespedes es distinto de este agente comercial. No accedas a datos de reservas de otras personas ni prometas que cualquier solicitud del huesped se ejecuta automaticamente.",
    "sources": [
      "src/pin-ai/runtime/pin-go-read-tool-executor.ts",
      "src/pin-ai/property-activation.ts"
    ]
  },
  {
    "id": "signup_and_plans",
    "es": "El registro de Pin&Go se realiza en https://pin-ngo.com. El checkout de registro contempla opciones de plataforma y paquetes con hardware, segun la seleccion y configuracion comercial.",
    "en": "Pin&Go registration is at https://pin-ngo.com. Signup checkout supports platform and hardware-package options according to the selected, configured offer.",
    "limit": "Cotiza solo con el catalogo de precios verificado para esta llamada. Sin un precio vigente confirmado, no cotices importes, impuestos, descuentos, plazos, inclusiones ni disponibilidad de hardware; dirige al registro para revisar la seleccion y el checkout. No crees la cuenta ni pidas contraseñas o tarjetas por telefono.",
    "sources": [
      "src/routes/public.signup.routes.ts",
      "src/services/signup-pricing.service.ts",
      "src/services/sales-voice-commercial.service.ts"
    ]
  }
];
export const salesVoiceProductFacts:readonly Fact[]=Object.freeze(
  [...reviewedFacts,...salesVoiceDetailedKnowledge].map(f=>Object.freeze({...f,sources:Object.freeze([...f.sources])})),
);
export const salesVoiceCoreTopicIds:readonly string[]=Object.freeze(reviewedFacts.map(f=>f.id));
export function buildSalesVoiceProductKnowledge():string {
  return [
    "Conocimiento comercial verificado de Pin&Go. Responde solo sobre la necesidad del interlocutor; no leas todo el catalogo. Usa la version ES o EN segun el idioma elegido, sin repetir ambas.",
    "Estas son capacidades de la plataforma, no prueba de activacion en la cuenta de un prospecto ni autorizacion para ejecutar acciones.",
    ...salesVoiceProductFacts.filter(f=>reviewedFacts.some(core=>core.id===f.id)).map(f=>f.es+" EN: "+f.en+" Condiciones: "+f.limit),
  ].join("\n");
}
export function buildSalesVoiceSalesCoaching():string {
  return [
    "Atiende como un asesor comercial preparado: escucha, responde la pregunta primero y conecta una funcion verificada con la necesidad expresada. Usa respuestas naturales y breves; amplia cuando te pidan detalle.",
    "Haz una sola pregunta relevante cada vez para entender si es propietario de una vivienda, administrador de varias propiedades, usuario de otro PMS o una empresa con requisitos especiales.",
    "Pregunta por numero de propiedades, proceso actual y principal dificultad solo cuando ayude a recomendar un siguiente paso. No recolectes email, telefono ni otros datos para un seguimiento que no puedes registrar o ejecutar.",
    "Para un propietario individual, explica el beneficio concreto que le interesa. Para un administrador, pregunta por coordinacion de su operacion. Para quien usa otro PMS, identifica lo que quiere mejorar sin prometer importaciones ni compatibilidad universal. Para una empresa, delimita sus requisitos sin inventar condiciones contractuales ni capacidades de marca personalizada.",
    "Ante objeciones de precio o esfuerzo, reconoce la inquietud y explica valor y requisitos verificables, sin descuentos inventados, presion, garantia de ingresos ni promesa de operacion sin ninguna intervencion humana.",
    "Distingue una pregunta comercial de soporte sobre una cuenta: puedes explicar el producto, pero no ver datos privados ni diagnosticar una reserva o conexion concreta sin acceso autorizado.",
    "Al cerrar, resume la necesidad, pregunta si quedan dudas y propone el registro seguro si hay interes. Puedes guiar verbalmente; no anuncies una cuenta creada, una cita confirmada, un mensaje enviado, un cobro o una venta completada sin una herramienta conectada y resultado verificado.",
    "Si falta un dato, dilo de inmediato y ofrece un paso que el cliente pueda realizar ahora. No inventes respuestas, no prometas consultas o seguimiento inexistentes y no compartas rutas de codigo, variables, credenciales ni identificadores internos.",
  ].join(" ");
}
