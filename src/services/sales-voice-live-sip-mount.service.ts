import type { SimulatedSalesVoiceRuntime } from "./sales-voice-runtime-composition.service.js";
import type { Express } from "express";
import type { PrismaClient } from "@prisma/client";
import { buildIsolatedSalesLiveSipRouter } from "./sales-voice-live-sip-auth.service.js";
import { ingestVerifiedLiveSipWithAdmission } from "./sales-voice-live-ingress-admission.service.js";

/**
 * Mount the existing signed GPT-Live SIP *metadata-only* ingress before
 * express.json(). The raw webhook body must remain intact for HMAC checking.
 *
 * Fail closed unless both release gates are explicitly set. The commercial
 * webhook signature is not the OpenAI API key used to accept a Live call.
 * In production this registration only saves authenticated metadata; an
 * explicitly gated NONPRODUCTION simulation can claim a database slot.
 * Neither mode calls /accept, sideband, Twilio or customer-facing messaging.
 */
export function mountSalesVoiceLiveSipWebhook(
  app: Pick<Express, "use">,
  db: Pick<PrismaClient, "salesVoiceCall">,
  env: Readonly<Record<string, string | undefined>>,
  runtime?: Pick<SimulatedSalesVoiceRuntime,"receiveVerified">,
): void {
  if(runtime && (env.NODE_ENV!=="test" || env.RAILWAY_ENVIRONMENT_NAME!=="sales-voice-certification"))
    throw new Error("SALES_RUNTIME_MOUNT_PRODUCTION_VETO");
  if(runtime && (env.SALES_VOICE_ADMISSION_SIMULATION_ENABLED==="true"
    ||env.SALES_VOICE_ADMISSION_SIMULATION_RELEASE_CERTIFIED==="true"))
    throw new Error("SALES_RUNTIME_LEGACY_ADMISSION_CONFLICT");
  app.use(buildIsolatedSalesLiveSipRouter({
    enabled: () =>
      env.SALES_VOICE_LIVE_WEBHOOK_ENABLED === "true"
      && env.SALES_VOICE_WEBHOOK_RELEASE_CERTIFIED === "true",
    webhookSecret: () => env.SALES_VOICE_OPENAI_WEBHOOK_SECRET,
    persist: invite => runtime ? runtime.receiveVerified(invite) : ingestVerifiedLiveSipWithAdmission({
      db, invite, env,
    }),
  }));
}
