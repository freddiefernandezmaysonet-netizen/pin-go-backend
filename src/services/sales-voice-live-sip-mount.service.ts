import type { Express } from "express";
import type { PrismaClient } from "@prisma/client";
import {
  buildIsolatedSalesLiveSipRouter,
  recordVerifiedLiveSipInvite,
} from "./sales-voice-live-sip-auth.service.js";

/**
 * Mount the existing signed GPT-Live SIP *metadata-only* ingress before
 * express.json(). The raw webhook body must remain intact for HMAC checking.
 *
 * Fail closed unless both release gates are explicitly set. The commercial
 * webhook signature is not the OpenAI API key used to accept a Live call.
 * This registration deliberately does not invoke admission, call accept,
 * sideband, Twilio or any customer-facing messaging.
 */
export function mountSalesVoiceLiveSipWebhook(
  app: Pick<Express, "use">,
  db: Pick<PrismaClient, "salesVoiceCall">,
  env: Readonly<Record<string, string | undefined>>,
): void {
  app.use(buildIsolatedSalesLiveSipRouter({
    enabled: () =>
      env.SALES_VOICE_LIVE_WEBHOOK_ENABLED === "true"
      && env.SALES_VOICE_WEBHOOK_RELEASE_CERTIFIED === "true",
    webhookSecret: () => env.SALES_VOICE_OPENAI_WEBHOOK_SECRET,
    persist: invite => recordVerifiedLiveSipInvite(db, invite),
  }));
}
