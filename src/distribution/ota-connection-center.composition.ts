import type { PrismaClient } from "@prisma/client";

import type { DistributionConnectionCenterActions } from "../routes/dashboard.distribution-connection-center.route.js";
import type {
  WhiteLabelProvisioner,
} from "./channex-white-label.adapter.js";
import type { OneTimeConnectionTokenIssuer } from "./ota-connection-session.service.js";
import {
  issueOtaConnectionSession,
  transitionOtaConnectionSession,
} from "./ota-connection-session.service.js";
import {
  prepareOtaDistributionConnection,
} from "./ota-distribution-persistence.service.js";
import {
  orchestrateOtaProvisioning,
  OtaProvisioningError,
  type OtaProvisioningRepository,
} from "./ota-connection-orchestrator.service.js";
import { PrismaOtaProvisioningRepository } from "./ota-provisioning.repository.js";
import { resolveOtaConnectionCenterRuntime } from "./ota-connection-runtime.policy.js";
import type { OtaConnectionCenterRuntime } from "./ota-connection-runtime.policy.js";
import { configureChannexBookingWebhookForConnectionCenter } from "../services/channex-booking-webhook-registration.service.js";

export type OtaConnectionCenterAdapter = WhiteLabelProvisioner & OneTimeConnectionTokenIssuer;

function canonicalConfiguredOrigins(
  values: readonly string[],
  protocols: ReadonlySet<string>
): ReadonlySet<string> {
  const origins = new Set<string>();
  for (const value of values) {
    try {
      const parsed = new URL(value);
      if (protocols.has(parsed.protocol) && !parsed.username && !parsed.password) {
        origins.add(parsed.origin);
      }
    } catch {
      // Invalid configuration is ignored and cannot authorize a request.
    }
  }
  return origins;
}

export function buildOtaConnectionCenterComposition(args: {
  prisma: PrismaClient;
  runtimeValue?: string;
  runtimeOverride?: OtaConnectionCenterRuntime;
  trustedMutationOrigins: readonly string[];
  allowedLaunchOrigins?: readonly string[];
  defaultCurrency?: string;
  adapter?: OtaConnectionCenterAdapter;
  isTenantOriginAllowed?(origin: string, organizationId: string): Promise<boolean>;
  repository?: OtaProvisioningRepository;
  prepareLogicalConnection?: typeof prepareOtaDistributionConnection;
  configureBookingWebhook?(input: {
    organizationId: string;
    propertyId: string;
  }): Promise<{ verified: boolean }>;
  configureChannelLifecycleWebhook?(input: {
    organizationId: string;
    propertyId: string;
  }): Promise<{ verified: boolean }>;
}): DistributionConnectionCenterActions {
  const requestedRuntime =
    args.runtimeOverride ?? resolveOtaConnectionCenterRuntime(args.runtimeValue);
  const trustedOrigins = canonicalConfiguredOrigins(
    args.trustedMutationOrigins,
    new Set(["https:", "http:"])
  );
  const allowedLaunchOrigins = canonicalConfiguredOrigins(
    args.allowedLaunchOrigins ?? [],
    new Set(["https:"])
  );
  const isTrustedOrigin = async (origin: string, organizationId: string) =>
    trustedOrigins.has(origin) ||
    Boolean(await args.isTenantOriginAllowed?.(origin, organizationId));

  if (!requestedRuntime.enabled) {
    return { runtime: requestedRuntime, isTrustedOrigin };
  }
  if (!args.adapter) {
    return {
      runtime: { enabled: false, reason: "ADAPTER_UNAVAILABLE" },
      isTrustedOrigin,
    };
  }
  if (!args.defaultCurrency || allowedLaunchOrigins.size === 0) {
    return {
      runtime: { enabled: false, reason: "CONFIGURATION_INCOMPLETE" },
      isTrustedOrigin,
    };
  }

  let repository: OtaProvisioningRepository;
  try {
    repository =
      args.repository ??
      new PrismaOtaProvisioningRepository(args.prisma as any, args.defaultCurrency);
  } catch {
    return {
      runtime: { enabled: false, reason: "CONFIGURATION_INCOMPLETE" },
      isTrustedOrigin,
    };
  }
  const prepareLogicalConnection = args.prepareLogicalConnection ?? prepareOtaDistributionConnection;
  const configureBookingWebhook =
    args.configureBookingWebhook ?? configureChannexBookingWebhookForConnectionCenter;

  return {
    runtime: { enabled: true, reason: "ENABLED" },
    isTrustedOrigin,
    prepare: async (input) => {
      const result = await orchestrateOtaProvisioning({
        repository,
        provisioner: args.adapter!,
        prepareLogicalConnection: (logicalInput) => prepareLogicalConnection({
          client: args.prisma as any,
          ...logicalInput,
        }),
        ...input,
      });
      // Inventory and the canonical PMS link are already committed. On webhook
      // failure the READY inventory can be reused without reprovisioning it.
      // Do not return a successful preparation until GET verification succeeds.
      try {
        const webhook = await configureBookingWebhook({
          organizationId: input.organizationId,
          propertyId: input.propertyId,
        });
        if (webhook.verified !== true) {
          throw new Error("CHANNEX_WEBHOOK_NOT_VERIFIED");
        }
      } catch {
        // Axios errors can carry request headers; never propagate that payload
        // through the host-facing Connection Center error boundary.
        throw new OtaProvisioningError("OTA_BOOKING_WEBHOOK_REGISTRATION_FAILED");
      }
      if (args.configureChannelLifecycleWebhook) {
        try {
          const lifecycleWebhook = await args.configureChannelLifecycleWebhook({
            organizationId: input.organizationId,
            propertyId: input.propertyId,
          });
          if (lifecycleWebhook.verified !== true) {
            throw new Error("OTA_CHANNEL_LIFECYCLE_WEBHOOK_NOT_VERIFIED");
          }
        } catch {
          throw new OtaProvisioningError(
            "OTA_CHANNEL_LIFECYCLE_WEBHOOK_REGISTRATION_FAILED"
          );
        }
      }
      return result;
    },
    issueSession: (input) => issueOtaConnectionSession({
      client: args.prisma as any,
      issuer: args.adapter!,
      allowedLaunchOrigins,
      ...input,
    }),
    transitionSession: (input) => transitionOtaConnectionSession({
      client: args.prisma as any,
      ...input,
    }),
  };
}
