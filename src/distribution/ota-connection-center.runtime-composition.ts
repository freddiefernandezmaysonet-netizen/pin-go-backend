import type { PrismaClient } from "@prisma/client";

import type { DistributionConnectionCenterActions } from "../routes/dashboard.distribution-connection-center.route.js";
import { ChannexWhiteLabelAdapter } from "./channex-white-label.adapter.js";
import { createChannexWhiteLabelHttpTransport } from "./channex-white-label.http-transport.js";
import { createChannexReadonlyHttpTransport } from "./channex-readonly.http-transport.js";
import { reconcileCanonicalOtaReadiness } from "./channex-canonical-readiness.service.js";
import { applyChannexChannelLifecycleEvidence } from "./channex-channel-lifecycle.evidence.js";
import { buildOtaConnectionCenterComposition } from "./ota-connection-center.composition.js";
import { resolveOtaConnectionCenterConfig } from "./ota-connection-center.config.js";

function withChannelLifecycle(args: {
  actions: DistributionConnectionCenterActions;
  prisma: PrismaClient;
  env: Readonly<Record<string, string | undefined>>;
}): DistributionConnectionCenterActions {
  return {
    ...args.actions,
    channelLifecycle: {
      enabled: args.env.OTA_CHANNEL_LIFECYCLE_ENABLED === "true",
      expectedSecret: String(args.env.OTA_CHANNEL_WEBHOOK_SECRET ?? "").trim(),
      applyEvidence: (payload) =>
        applyChannexChannelLifecycleEvidence({
          client: args.prisma,
          payload,
        }),
    },
  };
}

export function buildRuntimeOtaConnectionCenterComposition(args: {
  prisma: PrismaClient;
  env: Readonly<Record<string, string | undefined>>;
  trustedMutationOrigins: readonly string[];
  isTenantOriginAllowed?(origin: string, organizationId: string): Promise<boolean>;
  fetchImpl?: typeof fetch;
}): DistributionConnectionCenterActions {
  const config = resolveOtaConnectionCenterConfig(args.env);
  if (!config.enabled) {
    return withChannelLifecycle({
      prisma: args.prisma,
      env: args.env,
      actions: buildOtaConnectionCenterComposition({
        prisma: args.prisma,
        runtimeOverride: config,
        trustedMutationOrigins: args.trustedMutationOrigins,
        isTenantOriginAllowed: args.isTenantOriginAllowed,
      }),
    });
  }

  const transport = createChannexWhiteLabelHttpTransport({
    apiOrigin: config.provider.apiOrigin,
    timeoutMs: config.provider.timeoutMs,
    fetchImpl: args.fetchImpl,
  });
  const readonlyTransport = createChannexReadonlyHttpTransport({
    apiOrigin: config.provider.apiOrigin,
    apiKey: config.provider.apiKey,
    timeoutMs: config.provider.timeoutMs,
    fetchImpl: args.fetchImpl,
  });
  const adapter = new ChannexWhiteLabelAdapter({
    enabled: true,
    apiKey: config.provider.apiKey,
    iframeBaseUrl: config.provider.iframeBaseUrl,
    channelFilterByProvider: config.provider.channelFilterByProvider,
    transport,
  });

  const actions = buildOtaConnectionCenterComposition({
    prisma: args.prisma,
    runtimeValue: "true",
    trustedMutationOrigins: args.trustedMutationOrigins,
    allowedLaunchOrigins: config.provider.allowedLaunchOrigins,
    defaultCurrency: config.provider.defaultCurrency,
    adapter,
    isTenantOriginAllowed: args.isTenantOriginAllowed,
  });

  return withChannelLifecycle({
    prisma: args.prisma,
    env: args.env,
    actions: {
      ...actions,
      reconcile: ({ organizationId, propertyId, provider }) =>
        reconcileCanonicalOtaReadiness({
          client: args.prisma,
          transport: readonlyTransport,
          organizationId,
          propertyId,
          provider,
        }),
    },
  });
}
