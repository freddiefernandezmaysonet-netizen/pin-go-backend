import type { PrismaClient } from "@prisma/client";

import { applyChannexChannelLifecycleEvidence } from "./channex-channel-lifecycle.evidence.js";
import { buildChannexChannelLifecycleWebhookRouter } from "../routes/channex-channel-lifecycle.webhook.route.js";

export const OTA_CHANNEL_LIFECYCLE_ENABLED_ENV =
  "OTA_CHANNEL_LIFECYCLE_ENABLED";
export const OTA_CHANNEL_WEBHOOK_SECRET_ENV =
  "OTA_CHANNEL_WEBHOOK_SECRET";

export function buildRuntimeOtaChannelLifecycleRouter(args: {
  prisma: PrismaClient;
  env?: NodeJS.ProcessEnv;
}) {
  const env = args.env ?? process.env;
  const enabled = env[OTA_CHANNEL_LIFECYCLE_ENABLED_ENV] === "true";
  const expectedSecret = String(
    env[OTA_CHANNEL_WEBHOOK_SECRET_ENV] ?? ""
  ).trim();

  return buildChannexChannelLifecycleWebhookRouter({
    enabled,
    expectedSecret,
    applyEvidence: (payload) =>
      applyChannexChannelLifecycleEvidence({
        client: args.prisma,
        payload,
      }),
  });
}
