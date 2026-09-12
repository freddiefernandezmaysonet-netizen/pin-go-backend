import { createHmac } from "node:crypto";

import type { PrismaClient } from "@prisma/client";

import type { DistributionConnectionCenterActions } from "../routes/dashboard.distribution-connection-center.route.js";
import {
  issueAirbnbHostConnectionLink,
  verifyAirbnbHostCallback,
  verifyAirbnbHostState,
  type AirbnbHostSelfServiceClient,
  type AirbnbHostSelfServiceTransport,
} from "./airbnb-host-self-service.service.js";
import {
  discoverAirbnbListings,
  type AirbnbListingDiscoveryClient,
} from "./airbnb-host-self-service.listings.service.js";
import { createAirbnbListingDiscoveryHttpTransport } from "./airbnb-host-self-service.listings.http-transport.js";
import {
  confirmAirbnbHostMapping,
  type AirbnbHostConfirmedMappingClient,
} from "./airbnb-host-confirmed-mapping.service.js";
import { createAirbnbHostConfirmedMappingHttpTransport } from "./airbnb-host-confirmed-mapping.http-transport.js";
import {
  captureAirbnbCallbackPersistenceGuard,
  verifyAndPersistAirbnbHostCallback,
} from "./airbnb-host-self-service.callback-persistence.js";
import { ChannexWhiteLabelAdapter } from "./channex-white-label.adapter.js";
import { createChannexWhiteLabelHttpTransport } from "./channex-white-label.http-transport.js";
import { createChannexReadonlyHttpTransport } from "./channex-readonly.http-transport.js";
import {
  reconcileCanonicalOtaReadiness,
  type CanonicalOtaReadinessClient,
} from "./channex-canonical-readiness.service.js";
import { applyChannexChannelLifecycleEvidence } from "./channex-channel-lifecycle.evidence.js";
import { buildOtaConnectionCenterComposition } from "./ota-connection-center.composition.js";
import { resolveOtaConnectionCenterConfig } from "./ota-connection-center.config.js";

const AIRBNB_CALLBACK_ORIGIN = "https://app.pin-ngo.com";
const AIRBNB_STATE_DOMAIN = "pin-go:ota:airbnb-host-self-service:v1";

function adaptPrismaCanonicalReadinessClient(
  prisma: PrismaClient
): CanonicalOtaReadinessClient {
  return {
    distributionProperty: {
      async findFirst(query) {
        return await prisma.distributionProperty.findFirst(query as any) as any;
      },
    },
    otaChannelConnection: {
      async findFirst(query) {
        return await prisma.otaChannelConnection.findFirst(query as any) as any;
      },
    },
    channexAriPropertyState: {
      async findUnique(query) {
        return await prisma.channexAriPropertyState.findUnique(query as any) as any;
      },
    },
    pmsListing: {
      async findMany(query) {
        return await prisma.pmsListing.findMany(query as any) as any;
      },
    },
    distributionOutboxEvent: {
      async findMany(query) {
        return await prisma.distributionOutboxEvent.findMany(query as any) as any;
      },
    },
    apmsAuditEntry: {
      async findUnique(query) {
        return await prisma.apmsAuditEntry.findUnique(query as any) as any;
      },
    },
    async $transaction(work, options) {
      return prisma.$transaction(
        async (tx) =>
          work({
            distributionProperty: {
              async findFirst(query) {
                return await tx.distributionProperty.findFirst(query as any) as any;
              },
            },
            otaChannelConnection: {
              async findFirst(query) {
                return await tx.otaChannelConnection.findFirst(query as any) as any;
              },
              async updateMany(query) {
                return tx.otaChannelConnection.updateMany(query as any);
              },
            },
            channexAriPropertyState: {
              async findUnique(query) {
                return await tx.channexAriPropertyState.findUnique(query as any) as any;
              },
            },
            pmsListing: {
              async findMany(query) {
                return await tx.pmsListing.findMany(query as any) as any;
              },
            },
            distributionOutboxEvent: {
              async findMany(query) {
                return await tx.distributionOutboxEvent.findMany(query as any) as any;
              },
            },
            apmsAuditEntry: {
              async findUnique(query) {
                return await tx.apmsAuditEntry.findUnique(query as any) as any;
              },
              async create(query) {
                return tx.apmsAuditEntry.create(query as any);
              },
            },
          }),
        options as any
      );
    },
  };
}

function adaptPrismaAirbnbHostSelfServiceClient(
  prisma: PrismaClient
): AirbnbHostSelfServiceClient {
  return {
    distributionProperty: {
      async findFirst(query) {
        return await prisma.distributionProperty.findFirst(query as any) as any;
      },
    },
  };
}

function adaptPrismaAirbnbListingDiscoveryClient(
  prisma: PrismaClient
): AirbnbListingDiscoveryClient {
  return {
    otaChannelConnection: {
      async findFirst(query) {
        return await prisma.otaChannelConnection.findFirst(query as any) as any;
      },
    },
    property: {
      async findMany(query) {
        return await prisma.property.findMany(query as any) as any;
      },
    },
  };
}

function adaptPrismaAirbnbHostConfirmedMappingClient(
  prisma: PrismaClient
): AirbnbHostConfirmedMappingClient {
  return {
    distributionProperty: {
      async findFirst(query) {
        return await prisma.distributionProperty.findFirst(query as any) as any;
      },
    },
    otaChannelConnection: {
      async findFirst(query) {
        return await prisma.otaChannelConnection.findFirst(query as any) as any;
      },
    },
  };
}

function deriveAirbnbStateSecret(jwtSecret: string | undefined): string | null {
  const source = String(jwtSecret ?? "").trim();
  if (source.length < 32 || source.length > 4096) return null;
  return createHmac("sha256", source)
    .update(AIRBNB_STATE_DOMAIN)
    .digest("hex");
}

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
  const airbnbListingTransport = createAirbnbListingDiscoveryHttpTransport({
    apiOrigin: config.provider.apiOrigin,
    apiKey: config.provider.apiKey,
    timeoutMs: config.provider.timeoutMs,
    fetchImpl: args.fetchImpl,
  });
  const airbnbMappingTransport = createAirbnbHostConfirmedMappingHttpTransport({
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
  const canonicalReadinessClient = adaptPrismaCanonicalReadinessClient(
    args.prisma
  );
  const airbnbClient = adaptPrismaAirbnbHostSelfServiceClient(args.prisma);
  const airbnbListingClient = adaptPrismaAirbnbListingDiscoveryClient(args.prisma);
  const airbnbMappingClient = adaptPrismaAirbnbHostConfirmedMappingClient(args.prisma);
  const airbnbStateSecret = deriveAirbnbStateSecret(args.env.JWT_SECRET);
  const airbnbCallbackAllowed = args.trustedMutationOrigins.some(
    (origin) => String(origin).trim() === AIRBNB_CALLBACK_ORIGIN
  );
  const airbnbTransport: AirbnbHostSelfServiceTransport = {
    createConnectionLink(body) {
      return transport.send({
        method: "POST",
        path: "/api/v1/meta/airbnb/connection_link",
        headers: {
          "user-api-key": config.provider.apiKey,
          "Content-Type": "application/json",
        },
        body,
      });
    },
    getChannel(channelId) {
      return readonlyTransport.getChannel(channelId);
    },
  };

  const discoverListings = (input: {
    organizationId: string;
    propertyId: string;
  }) =>
    discoverAirbnbListings({
      client: airbnbListingClient,
      transport: airbnbListingTransport,
      organizationId: input.organizationId,
      propertyId: input.propertyId,
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
      airbnbHostSelfService: {
        enabled: Boolean(airbnbStateSecret && airbnbCallbackAllowed),
        isTrustedOrigin: actions.isTrustedOrigin,
        issueConnectionLink: ({
          organizationId,
          propertyId,
          requestedByUserId,
        }) =>
          issueAirbnbHostConnectionLink({
            client: airbnbClient,
            transport: airbnbTransport,
            stateSecret: airbnbStateSecret ?? "",
            callbackOrigin: AIRBNB_CALLBACK_ORIGIN,
            providerOrigin: config.provider.apiOrigin,
            organizationId,
            propertyId,
            requestedByUserId,
          }),
        listListings: discoverListings,
        confirmMapping: ({
          organizationId,
          propertyId,
          listingId,
          confirmation,
        }) =>
          confirmAirbnbHostMapping({
            client: airbnbMappingClient,
            readonlyTransport,
            mappingTransport: airbnbMappingTransport,
            discoverListings,
            organizationId,
            propertyId,
            listingId,
            confirmation,
          }),
        verifyCallback: async ({
          organizationId,
          requestedByUserId,
          success,
          channelId,
          token,
        }) => {
          if (success !== "true") {
            return verifyAirbnbHostCallback({
              client: airbnbClient,
              transport: airbnbTransport,
              stateSecret: airbnbStateSecret ?? "",
              organizationId,
              requestedByUserId,
              success,
              channelId,
              token,
            });
          }
          const claims = verifyAirbnbHostState({
            token,
            secret: airbnbStateSecret ?? "",
            organizationId,
            requestedByUserId,
          });
          const guard = await captureAirbnbCallbackPersistenceGuard({
            client: args.prisma as any,
            organizationId,
            propertyId: claims.propertyId,
            channelId: String(channelId ?? ""),
          });
          return verifyAndPersistAirbnbHostCallback({
            verify: () =>
              verifyAirbnbHostCallback({
                client: airbnbClient,
                transport: airbnbTransport,
                stateSecret: airbnbStateSecret ?? "",
                organizationId,
                requestedByUserId,
                success,
                channelId,
                token,
              }),
            client: args.prisma as any,
            guard,
            organizationId,
            requestedByUserId,
          });
        },
      },
      reconcile: ({
        organizationId,
        propertyId,
        requestedByUserId,
        provider,
        requestKey,
      }) =>
        reconcileCanonicalOtaReadiness({
          client: canonicalReadinessClient,
          transport: readonlyTransport,
          organizationId,
          propertyId,
          requestedByUserId,
          provider,
          requestKey,
        }),
    },
  });
}
