import {
  derivePropertyCommercialDistributionStatus,
  type OtaChannelConnectionStatus,
  type OtaReadinessStatus,
} from "./ota-commercial-lifecycle.policy";

export const CONNECTION_CENTER_CATALOG = [
  { provider: "AIRBNB", name: "Airbnb", availability: "AVAILABLE" },
  { provider: "BOOKING_COM", name: "Booking.com", availability: "AVAILABLE" },
  { provider: "EXPEDIA", name: "Expedia", availability: "PLANNED" },
  { provider: "VRBO", name: "Vrbo", availability: "ASSISTED_BETA" },
] as const;

export type ConnectionCenterProvider =
  (typeof CONNECTION_CENTER_CATALOG)[number]["provider"];

export type StoredOtaChannel = {
  provider: ConnectionCenterProvider;
  status: OtaChannelConnectionStatus;
  authorizationReadiness: OtaReadinessStatus;
  mappingReadiness: OtaReadinessStatus;
  distributionReadiness: OtaReadinessStatus;
  paymentReadiness: OtaReadinessStatus;
  taxReadiness: OtaReadinessStatus;
  contentReadiness: OtaReadinessStatus;
  lastReadinessCheckedAt: Date | null;
  lastFullSyncConfirmedAt: Date | null;
  activatedAt: Date | null;
  lastErrorCode: string | null;
};

function nextAction(status: OtaChannelConnectionStatus) {
  switch (status) {
    case "NOT_CONNECTED":
    case "DISCONNECTED":
      return "CONNECT" as const;
    case "AUTHORIZATION_REQUIRED":
      return "AUTHORIZE" as const;
    case "MAPPING_REQUIRED":
      return "COMPLETE_MAPPING" as const;
    case "READINESS_CHECK":
    case "ACTIVATION_PENDING":
    case "DISCONNECTING":
      return "WAITING" as const;
    case "ACTIVE":
      return "MANAGE" as const;
    case "DEGRADED":
    case "FAILED":
      return "REPAIR" as const;
  }
}

export function buildConnectionCenterReadModel(args: {
  property: { id: string; name: string };
  distributionProperty: {
    provisioningStatus: "NOT_PROVISIONED" | "PROVISIONING" | "READY" | "FAILED";
    channels: StoredOtaChannel[];
  } | null;
}) {
  const storedByProvider = new Map(
    (args.distributionProperty?.channels ?? []).map((channel) => [
      channel.provider,
      channel,
    ])
  );
  const channels = CONNECTION_CENTER_CATALOG.map((catalogItem) => {
    const stored = storedByProvider.get(catalogItem.provider);
    const status = stored?.status ?? "NOT_CONNECTED";

    return {
      ...catalogItem,
      status,
      nextAction: nextAction(status),
      readiness: {
        authorization: stored?.authorizationReadiness ?? "REQUIRED",
        mapping: stored?.mappingReadiness ?? "NOT_STARTED",
        distribution: stored?.distributionReadiness ?? "NOT_STARTED",
        payment: stored?.paymentReadiness ?? "NOT_STARTED",
        tax: stored?.taxReadiness ?? "NOT_STARTED",
        content: stored?.contentReadiness ?? "NOT_STARTED",
      },
      lastReadinessCheckedAt:
        stored?.lastReadinessCheckedAt?.toISOString() ?? null,
      lastFullSyncConfirmedAt:
        stored?.lastFullSyncConfirmedAt?.toISOString() ?? null,
      activatedAt: stored?.activatedAt?.toISOString() ?? null,
      attentionCode: stored?.lastErrorCode ?? null,
    };
  });

  return {
    productName: "Distribution by Pin&Go" as const,
    property: args.property,
    status: derivePropertyCommercialDistributionStatus(
      args.distributionProperty?.channels.map((channel) => channel.status) ?? []
    ),
    provisioningStatus:
      args.distributionProperty?.provisioningStatus ?? "NOT_PROVISIONED",
    channels,
  };
}
