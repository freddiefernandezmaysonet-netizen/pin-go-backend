import type { PrismaClient } from "@prisma/client";

import type { DistributionConnectionCenterActions } from "../routes/dashboard.distribution-connection-center.route.js";
import { ChannexWhiteLabelAdapter } from "./channex-white-label.adapter.js";
import { createChannexWhiteLabelHttpTransport } from "./channex-white-label.http-transport.js";
import { buildOtaConnectionCenterComposition } from "./ota-connection-center.composition.js";
import { resolveOtaConnectionCenterConfig } from "./ota-connection-center.config.js";

export function buildRuntimeOtaConnectionCenterComposition(args: {
  prisma: PrismaClient;
  env: Readonly<Record<string, string | undefined>>;
  trustedMutationOrigins: readonly string[];
  isTenantOriginAllowed?(origin: string, organizationId: string): Promise<boolean>;
  fetchImpl?: typeof fetch;
}): DistributionConnectionCenterActions {
  const config = resolveOtaConnectionCenterConfig(args.env);
  if (!config.enabled) {
    return buildOtaConnectionCenterComposition({
      prisma: args.prisma,
      runtimeOverride: config,
      trustedMutationOrigins: args.trustedMutationOrigins,
      isTenantOriginAllowed: args.isTenantOriginAllowed,
    });
  }

  const transport = createChannexWhiteLabelHttpTransport({
    apiOrigin: config.provider.apiOrigin,
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

  return buildOtaConnectionCenterComposition({
    prisma: args.prisma,
    runtimeValue: "true",
    trustedMutationOrigins: args.trustedMutationOrigins,
    allowedLaunchOrigins: config.provider.allowedLaunchOrigins,
    defaultCurrency: config.provider.defaultCurrency,
    adapter,
    isTenantOriginAllowed: args.isTenantOriginAllowed,
  });
}
