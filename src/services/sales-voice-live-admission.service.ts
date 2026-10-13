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
const HELD = ["ADMISSION_CLAIMED", "ACCEPTED", "ACCEPT_UNKNOWN"] as const;
type HeldStatus = (typeof HELD)[number];

export type AdmissionLimits = {
  enabled: boolean;
  maxConcurrentCalls: number;
  monthlyBudgetCents: number;
  estimatedCentsPerMinute: number;
  reservedSecondsPerCall: number;
};
function validLimits(l: AdmissionLimits): void {
  if (!l.enabled) deny("DISABLED");
  if (!Number.isSafeInteger(l.maxConcurrentCalls) || l.maxConcurrentCalls < 1 || l.maxConcurrentCalls > 10
    || !Number.isSafeInteger(l.monthlyBudgetCents) || l.monthlyBudgetCents < 1
    || !Number.isSafeInteger(l.estimatedCentsPerMinute) || l.estimatedCentsPerMinute < 1
    || !Number.isSafeInteger(l.reservedSecondsPerCall) || l.reservedSecondsPerCall < 60
    || l.reservedSecondsPerCall > 3600) deny("INVALID_LIMITS");
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
        select: { status: true, durationSeconds: true },
      });
      const usage = rows.reduce((sum, row) => sum + reserve(
        HELD.includes(row.status as HeldStatus)
          ? limits.reservedSecondsPerCall
          : Math.max(0, row.durationSeconds ?? limits.reservedSecondsPerCall),
        limits.estimatedCentsPerMinute,
      ), 0);
      if (usage + reserve(limits.reservedSecondsPerCall, limits.estimatedCentsPerMinute)
        > limits.monthlyBudgetCents) deny("ESTIMATED_MONTHLY_BUDGET_LIMIT");
      const changed = await tx.salesVoiceCall.updateMany({
        where: { id: call.id, status: "RECEIVED" },
        data: { status: "ADMISSION_CLAIMED" },
      });
      if (changed.count !== 1) deny("CLAIM_RACE");
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
  "Identificate claramente como inteligencia artificial. Habla en español o ingles, segun la preferencia del interlocutor.",
  "Explica la plataforma a nivel general sin inventar precios, descuentos, disponibilidad o funciones no verificadas.",
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
