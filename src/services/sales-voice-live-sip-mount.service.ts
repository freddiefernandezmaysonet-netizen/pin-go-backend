import {diagnoseSalesVoiceIngress} from "./sales-voice-ingress-diagnostics.service.js";
import {bootSalesVoiceRuntime,type SalesVoiceBootDependencies} from "./sales-voice-runtime-boot.service.js";
import type { SimulatedSalesVoiceRuntime } from "./sales-voice-runtime-composition.service.js";
import type { Express } from "express";
import type { PrismaClient } from "@prisma/client";
import { buildIsolatedSalesLiveSipRouter } from "./sales-voice-live-sip-auth.service.js";
import { ingestVerifiedLiveSipWithAdmission } from "./sales-voice-live-ingress-admission.service.js";

/**
 * Mount signed GPT-Live SIP ingress (metadata-only by default) before
 * express.json(). The raw webhook body must remain intact for HMAC checking.
 *
 * Fail closed unless both release gates are explicitly set. The commercial
 * webhook signature is not the OpenAI API key used to accept a Live call.
 * In production this registration only saves authenticated metadata; an
 * explicitly gated NONPRODUCTION simulation can claim a database slot.
 * A separately boot-gated test environment may compose supervised execution.
 * Private production certification is boot-owned and bounded separately.
 * Explicit production runtime injection remains prohibited; no Twilio setup.
 */
export function mountSalesVoiceLiveSipWebhook(
  app: Pick<Express, "use">,
  db: Pick<PrismaClient, "salesVoiceCall">,
  env: Readonly<Record<string, string | undefined>>,
  runtime?: Pick<SimulatedSalesVoiceRuntime,"receiveVerified">,
  bootDependencies?: SalesVoiceBootDependencies,
): void {
  if(runtime && (env.NODE_ENV!=="test" || env.RAILWAY_ENVIRONMENT_NAME!=="sales-voice-certification"))
    throw new Error("SALES_RUNTIME_MOUNT_PRODUCTION_VETO");
  if(runtime && (env.SALES_VOICE_ADMISSION_SIMULATION_ENABLED==="true"
    ||env.SALES_VOICE_ADMISSION_SIMULATION_RELEASE_CERTIFIED==="true"))
    throw new Error("SALES_RUNTIME_LEGACY_ADMISSION_CONFLICT");
  const booted=runtime?undefined:bootSalesVoiceRuntime(
    db as Pick<PrismaClient,"salesVoiceCall"|"$transaction"|"$queryRaw">,env,bootDependencies,
  );
  const execution=runtime??booted;
  try { app.use(buildIsolatedSalesLiveSipRouter({
    enabled: () =>
      env.SALES_VOICE_LIVE_WEBHOOK_ENABLED === "true"
      && env.SALES_VOICE_WEBHOOK_RELEASE_CERTIFIED === "true",
    webhookSecret: () => env.SALES_VOICE_OPENAI_WEBHOOK_SECRET,
    persist: invite => diagnoseSalesVoiceIngress<unknown>(() => execution ? execution.receiveVerified(invite) : ingestVerifiedLiveSipWithAdmission({
      db, invite, env,
    }), booted ? () => booted.snapshot() : undefined),
  })); } catch(error) {
    booted?.stop();
    throw error;
  }
}
