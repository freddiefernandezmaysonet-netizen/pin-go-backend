import {buildSalesVoiceProductKnowledge,buildSalesVoiceSalesCoaching} from "./sales-voice-product-knowledge.service.js";
import {SALES_VOICE_CERTIFICATION_MAX_RESERVED_SECONDS} from "./sales-voice-certification-profile.service.js";
import type { PrismaClient, SalesVoiceCall } from "@prisma/client";

/**
 * Draft-only, NOT mounted on server or linked to webhooks. A VERIFIED OpenAI
 * Live SIP event is required before admission. Accepts are one-shot; ambiguous
 * responses hold capacity until reconciliation. NO call-end watchdog yet.
 */
export class SalesVoiceAdmissionError extends Error {
  constructor(readonly code: string) { super(code); this.name = "SalesVoiceAdmissionError"; }
}
const deny = (code: string): never => { throw new SalesVoiceAdmissionError(code); };
const HELD = ["ADMISSION_CLAIMED", "ACCEPTED", "ACCEPT_UNKNOWN", "HANGUP_CLAIMED", "HANGUP_SENT", "HANGUP_UNKNOWN"] as const;
type HeldStatus = (typeof HELD)[number];

export type AdmissionLimits = {
  enabled: boolean;
  developmentUnrestricted?: boolean;
  maxConcurrentCalls: number;
  monthlyBudgetCents: number;
  estimatedCentsPerMinute: number;
  reservedSecondsPerCall: number;
  certificationWindow?: Readonly<{startsAtMs:number;endsAtMs:number}>;
};
function validLimits(l: AdmissionLimits): void {
  if (!l.enabled) deny("DISABLED");
  if (!Number.isSafeInteger(l.maxConcurrentCalls) || l.maxConcurrentCalls < 1 || l.maxConcurrentCalls > 10
    || !Number.isSafeInteger(l.monthlyBudgetCents) || l.monthlyBudgetCents < 1
    || !Number.isSafeInteger(l.estimatedCentsPerMinute) || l.estimatedCentsPerMinute < 1
    || !Number.isSafeInteger(l.reservedSecondsPerCall) || l.reservedSecondsPerCall < 60
    || l.reservedSecondsPerCall > 3600) deny("INVALID_LIMITS");
  if(l.developmentUnrestricted!==undefined&&typeof l.developmentUnrestricted!=="boolean")deny("INVALID_LIMITS");
  if(l.developmentUnrestricted&&l.certificationWindow)deny("INVALID_CERTIFICATION_WINDOW");
  const w=l.certificationWindow;
  if(w && (!Number.isSafeInteger(w.startsAtMs)||!Number.isSafeInteger(w.endsAtMs)
    ||w.startsAtMs<=0||w.endsAtMs<=w.startsAtMs||w.endsAtMs-w.startsAtMs>15*60*1000
    ||l.maxConcurrentCalls!==1||l.reservedSecondsPerCall>SALES_VOICE_CERTIFICATION_MAX_RESERVED_SECONDS))
    deny("INVALID_CERTIFICATION_WINDOW");
}
function sessionId(value: string): string {
  if (typeof value !== "string" || !/^live_[A-Za-z0-9_-]{1,123}$/.test(value)) deny("INVALID_SESSION_ID");
  return value;
}
const reserve = (seconds: number, centsPerMinute: number) =>
  Math.ceil(seconds / 60) * centsPerMinute;
const monthStart = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
type DB = Pick<PrismaClient, "$transaction" | "salesVoiceCall">;

export class SalesVoiceLiveAdmission {
  constructor(private readonly db: DB) {}

  // A global PostgreSQL advisory transaction lock serializes claims across
  // Railway workers. Fixed raw SQL, never interpolated user input.
  async claim(id: string, limits: AdmissionLimits, now = new Date()): Promise<{
    result: "CLAIMED" | "ALREADY_CLAIMED";
    call: SalesVoiceCall;
  }> {
    sessionId(id);
    limits={...limits,certificationWindow:limits.certificationWindow?{...limits.certificationWindow}:undefined};
    validLimits(limits);
    if (!Number.isFinite(now.getTime())) deny("INVALID_TIME");
    return this.db.$transaction(async tx => {
      await tx.$queryRawUnsafe("SELECT pg_advisory_xact_lock(414812, 20261013)::text AS lock_held");
      const call = await tx.salesVoiceCall.findUnique({ where: { providerCallId: id } });
      if (!call || call.provider !== "OPENAI_LIVE_SIP" || call.direction !== "INBOUND")
        deny("VERIFIED_LIVE_CALL_REQUIRED");
      if (call.status !== "RECEIVED") {
        if (HELD.includes(call.status as HeldStatus))
          return { result: "ALREADY_CLAIMED" as const, call };
        deny("NOT_ADMISSIBLE_STATUS");
      }
      const window=limits.certificationWindow;
      if(window){
        // Read PostgreSQL time AFTER the global lock wait; caller clocks cannot
        // reopen an expired window. Leave the full reservation before its end.
        const [time]=await tx.$queryRaw<Array<{now:Date}>>`SELECT clock_timestamp() AS "now"`;
        if(!(time?.now instanceof Date)||!Number.isFinite(time.now.getTime()))
          deny("CERTIFICATION_DATABASE_CLOCK_REQUIRED");
        const clock=time.now.getTime();
        if(clock<window.startsAtMs||clock+limits.reservedSecondsPerCall*1000>window.endsAtMs)
          deny("CERTIFICATION_WINDOW_CLOSED");
        if(call.startedAt.getTime()<window.startsAtMs||call.startedAt.getTime()>clock)
          deny("CERTIFICATION_FRESH_INVITE_REQUIRED");
        // Any call that left RECEIVED conservatively consumes the attempt. The
        // existing global advisory lock makes this quota durable across restart.
        const used=await tx.salesVoiceCall.count({where:{
          provider:"OPENAI_LIVE_SIP",direction:"INBOUND",
          startedAt:{gte:new Date(window.startsAtMs),lte:new Date(window.endsAtMs)},
          status:{not:"RECEIVED"},
        }});
        if(used!==0)deny("CERTIFICATION_ATTEMPT_LIMIT");
      }
      if(!limits.developmentUnrestricted){
      const active = await tx.salesVoiceCall.count({
        where: { provider: "OPENAI_LIVE_SIP", status: { in: [...HELD] } },
      });
      if (active >= limits.maxConcurrentCalls) deny("CONCURRENCY_LIMIT");

      // Conservative estimate only; WITHOUT automatic hangup it is not a
      // hard monetary cap. No production activation before watchdog exists.
      const rows = await tx.salesVoiceCall.findMany({
        where: {
          provider: "OPENAI_LIVE_SIP",
          startedAt: { gte: monthStart(now), lte: now },
          status: { in: [...HELD, "COMPLETED"] },
        },
        select: { status: true, durationSeconds: true, lastUsageSeconds: true, finalUsageSeconds: true, startedAt: true, answeredAt: true },
      });
      const usage = rows.reduce((sum, row) => {
        const active = HELD.includes(row.status as HeldStatus);
        const wallSeconds = Math.max(0, Math.ceil((now.getTime()
          - (row.answeredAt ?? row.startedAt).getTime()) / 1000));
        const seconds = active
          ? Math.max(limits.reservedSecondsPerCall, wallSeconds, row.lastUsageSeconds ?? 0)
          : Math.max(0, row.finalUsageSeconds ?? row.lastUsageSeconds
            ?? row.durationSeconds ?? limits.reservedSecondsPerCall);
        return sum + reserve(seconds, limits.estimatedCentsPerMinute);
      }, 0);
      if (usage + reserve(limits.reservedSecondsPerCall, limits.estimatedCentsPerMinute)
        > limits.monthlyBudgetCents) deny("ESTIMATED_MONTHLY_BUDGET_LIMIT");
      } // Continuous development retains history, without pilot capacity/budget rejection.
      const changed = await tx.salesVoiceCall.updateMany({
        where: { id: call.id, status: "RECEIVED" },
        data: { status: "ADMISSION_CLAIMED" },
      });
      if (changed.count !== 1) deny("CLAIM_RACE");
      if(window){
        const [end]=await tx.$queryRaw<Array<{now:Date}>>`SELECT clock_timestamp() AS "now"`;
        if(!(end?.now instanceof Date)||!Number.isFinite(end.now.getTime())
          ||end.now.getTime()<window.startsAtMs
          ||end.now.getTime()+limits.reservedSecondsPerCall*1000>window.endsAtMs)
          deny("CERTIFICATION_WINDOW_CLOSED"); // rollback late claim before any provider request
      }
      return {
        result: "CLAIMED" as const,
        call: await tx.salesVoiceCall.findUniqueOrThrow({ where: { id: call.id } }),
      };
    });
  }

  async recordProviderOutcome(id: string, succeeded: boolean): Promise<SalesVoiceCall> {
    sessionId(id);
    const changed = await this.db.salesVoiceCall.updateMany({
      where: { providerCallId: id, provider: "OPENAI_LIVE_SIP", status: "ADMISSION_CLAIMED" },
      data: succeeded
        ? { status: "ACCEPTED", answeredAt: new Date() }
        : { status: "ACCEPT_UNKNOWN" },
    });
    if (changed.count !== 1) deny("OUTCOME_ALREADY_RECORDED");
    return this.db.salesVoiceCall.findUniqueOrThrow({ where: { providerCallId: id } });
  }
}

export type ProviderHTTP = (
  url: string,
  options: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<{ status: number }>;
const SCRIPT = [
  "Eres el asistente virtual de ventas de Pin&Go, una plataforma para gestionar propiedades vacacionales.",
  "Identificate claramente como inteligencia artificial en tu saludo inicial. Abre con un saludo breve en español e ingles y pregunta el idioma preferido. Si el interlocutor pide ingles, cambia inmediatamente a ingles y manten ese idioma hasta que pida otro. Si pide español, responde en español. Sin una preferencia explicita, usa el idioma de su primera intervencion. No cambies el idioma elegido solo porque mezcle palabras del otro idioma.",
  buildSalesVoiceProductKnowledge(),
  buildSalesVoiceSalesCoaching(),
  "Si preguntan si Pin&Go tiene Direct Booking, responde SI inmediatamente y explica esa funcion en el idioma elegido. Esa capacidad de la plataforma existe aunque este agente telefonico no tenga herramientas para consultar una propiedad concreta o crear una reserva.",
  "Explica la plataforma usando esta informacion verificada, sin inventar precios, descuentos, disponibilidad concreta ni otras funciones no verificadas.",
  "Este agente telefonico no tiene herramientas de consulta de cuentas o reservas, creacion de reservas, seguimiento ni contacto con personas conectadas. Puede explicar precios solo cuando reciba un catalogo vigente verificado para esta llamada. Nunca digas que vas a verificar, consultar, revisar, contactar a alguien o devolver una respuesta despues. No dejes una pregunta esperando una accion inexistente: responde con lo que sabes ahora o explica claramente que no tienes el dato confirmado.",
  "No afirmes haber creado cuentas, reservado citas, enviado mensajes o procesado pagos.",
  "Nunca solicites contraseñas, codigos de verificacion ni tarjetas bancarias.",
  "Para registrarse, indica la pagina segura app.pin-ngo.com/signup.",
  "Si una gestion requiere herramientas no conectadas, explica que aun no puedes realizarla.",
].join(" ");
export function salesVoiceStartupConfig() {
  return { session: {
    type: "live" as const,
    model: "gpt-live-1" as const,
    instructions: SCRIPT,
    // Seed the opening at acceptance; sideband recovery must not restart it.
    input: [{
      type: "message" as const,
      role: "developer" as const,
      content: [{ type: "input_text" as const, text:
        'Saluda ahora en español e ingles, sin esperar a que el interlocutor hable. Di: "Hola, soy el asistente de inteligencia artificial de Pin&Go. Hello, I am Pin&Go\'s AI assistant. ¿Prefieres español o inglés? Would you prefer Spanish or English?" Despues haz una pausa y escucha. Continua en el idioma que elija el interlocutor; si pide ingles, responde inmediatamente en ingles y mantenlo hasta que pida otro idioma.',
      }],
    }],
    audio: { output: { voice: "marin" as const } },
  } };
}

/** Exact official Live SIP accept endpoint. No automatic retry or redirect. */
export async function postOneOpenAILiveAccept(input: {
  sessionId: string;
  apiKey: string;
  transport: ProviderHTTP;
  explicitlyEnabled: boolean;
}): Promise<void> {
  sessionId(input.sessionId);
  if (!input.explicitlyEnabled) deny("TRANSPORT_DISABLED");
  if (!input.apiKey?.startsWith("sk-")) deny("API_KEY_REQUIRED");
  const response = await input.transport(
    "https://api.openai.com/v1/live/sessions/" + encodeURIComponent(input.sessionId) + "/accept",
    {
      method: "POST",
      headers: { Authorization: "Bearer " + input.apiKey, "Content-Type": "application/json" },
      body: JSON.stringify(salesVoiceStartupConfig()),
      signal: AbortSignal.timeout(5000),
    },
  );
  if (response.status !== 200) deny("ACCEPT_NOT_CONFIRMED");
}

/**
 * Claims once then issues at most one provider request. On error/timeout,
 * preserve ACCEPT_UNKNOWN: never retry until a separate reconciliation proves
 * the actual OpenAI call state. This is not a complete production controller.
 */
export async function attemptOneLiveAccept(input: {
  admission: SalesVoiceLiveAdmission;
  sessionId: string;
  limits: AdmissionLimits;
  apiKey: string;
  transport: ProviderHTTP;
  explicitlyEnabled: boolean;
}): Promise<"ACCEPTED" | "ACCEPT_UNKNOWN" | "ALREADY_CLAIMED"> {
  if (!input.explicitlyEnabled) deny("EXECUTION_DISABLED");
  const claim = await input.admission.claim(input.sessionId, input.limits);
  if (claim.result === "ALREADY_CLAIMED") return "ALREADY_CLAIMED";
  let accepted = false;
  try {
    await postOneOpenAILiveAccept({ sessionId: input.sessionId, apiKey: input.apiKey,
      transport: input.transport, explicitlyEnabled: true });
    accepted = true;
  } catch {
    // Ambiguous transport errors are not safe for retry.
  }
  await input.admission.recordProviderOutcome(input.sessionId, accepted);
  return accepted ? "ACCEPTED" : "ACCEPT_UNKNOWN";
}
