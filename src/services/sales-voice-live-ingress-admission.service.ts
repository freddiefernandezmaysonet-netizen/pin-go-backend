import type { PrismaClient } from "@prisma/client";
import {
  recordVerifiedLiveSipInvite,
  type VerifiedLiveSipInvitation,
} from "./sales-voice-live-sip-auth.service.js";
import {
  SalesVoiceLiveAdmission,
  type AdmissionLimits,
} from "./sales-voice-live-admission.service.js";

/**
 * Verified webhook -> durable ingress -> optional DB admission CLAIM.
 *
 * This adapter is deliberately NOT an API provider acceptance controller:
 * it cannot POST /accept, attach a Live sideband, start a worker or originate
 * Twilio traffic. A future independently certified controller must own those
 * steps and call the existing one-shot accept method.
 *
 * Production veto is unconditional, even if somebody incorrectly sets both
 * simulation flags true in Railway. No call is answered by this module.
 */
type Db = Pick<PrismaClient, "salesVoiceCall" | "$transaction">;
type Env = Readonly<Record<string, string | undefined>>;
type ClaimResult = "CLAIMED" | "ALREADY_CLAIMED";

export type SignedIngressAdmissionResult = Readonly<{
  state: "METADATA_ONLY" | ClaimResult;
  duplicate: boolean;
  sessionId: string;
}>;

export class SalesIngressAdmissionError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "SalesIngressAdmissionError";
  }
}
const reject = (code: string): never => { throw new SalesIngressAdmissionError(code); };

function simulationEnabled(env: Env): boolean {
  if (env.SALES_VOICE_ADMISSION_SIMULATION_ENABLED !== "true"
      || env.SALES_VOICE_ADMISSION_SIMULATION_RELEASE_CERTIFIED !== "true") {
    return false;
  }
  if (env.NODE_ENV !== "test" || env.RAILWAY_ENVIRONMENT_NAME !== "sales-voice-certification") {
    reject("PRODUCTION_SIMULATION_FORBIDDEN");
  }
  return true;
}

function integer(value: string | undefined, min: number, max: number): number {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d{0,8})$/.test(value)) {
    return reject("MISSING_OR_INVALID_ADMISSION_LIMIT");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    return reject("MISSING_OR_INVALID_ADMISSION_LIMIT");
  }
  return parsed;
}

function policy(env: Env): AdmissionLimits {
  return {
    enabled: true,
    maxConcurrentCalls: integer(env.SALES_VOICE_MAX_CONCURRENT_CALLS, 1, 2),
    monthlyBudgetCents: integer(env.SALES_VOICE_MONTHLY_BUDGET_CENTS, 1, 100000),
    estimatedCentsPerMinute: integer(env.SALES_VOICE_ESTIMATED_CENTS_PER_MINUTE, 1, 1000),
    reservedSecondsPerCall: integer(env.SALES_VOICE_RESERVED_SECONDS_PER_CALL, 60, 3600),
  };
}

export async function ingestVerifiedLiveSipWithAdmission(input: {
  db: Db;
  invite: VerifiedLiveSipInvitation;
  env: Env;
  admission?: Pick<SalesVoiceLiveAdmission, "claim">;
}): Promise<SignedIngressAdmissionResult> {
  // Validate all non-default simulation controls before any database write.
  const canSimulate = simulationEnabled(input.env);
  const limits = canSimulate ? policy(input.env) : null;

  // Idempotency and ownership come from the pre-existing verified session
  // ingestion. The surrounding router MUST verify HMAC on the raw request.
  const persisted = await recordVerifiedLiveSipInvite(input.db, input.invite);

  if (!limits) {
    return {
      state: "METADATA_ONLY",
      duplicate: persisted.duplicate,
      sessionId: input.invite.sessionId,
    };
  }

  const admission = input.admission ?? new SalesVoiceLiveAdmission(input.db);
  if (typeof admission.claim !== "function") reject("ADMISSION_REQUIRED");
  const result = await admission.claim(input.invite.sessionId, limits);
  return {
    state: result.result,
    duplicate: persisted.duplicate,
    sessionId: input.invite.sessionId,
  };
}
