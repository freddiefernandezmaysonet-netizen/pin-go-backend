import type { ConnectionCenterProvider } from "./connection-center.read-model.js";
import type { OneTimeConnectionTokenIssuer } from "./ota-connection-session.service.js";

export type WhiteLabelTransportRequest = {
  method: "POST";
  path: string;
  headers: Readonly<Record<string, string>>;
  body: unknown;
};

export type WhiteLabelHttpTransport = {
  send(request: WhiteLabelTransportRequest): Promise<unknown>;
};

export type ProvisionedGroup = { externalGroupId: string };
export type ProvisionedPropertyInventory = {
  externalPropertyId: string;
  externalPrimaryRoomTypeId: string;
  externalPrimaryRatePlanId: string;
};

export type WhiteLabelProvisioner = {
  ensureGroup(args: {
    organizationId: string;
    organizationName: string;
    existingExternalGroupId: string | null;
  }): Promise<ProvisionedGroup>;
  ensureProperty(args: {
    organizationId: string;
    propertyId: string;
    propertyName: string;
    currency: string;
    timezone: string;
    externalGroupId: string;
    existingExternalPropertyId: string | null;
  }): Promise<{ externalPropertyId: string }>;
  ensurePrimaryRoomType(args: {
    externalPropertyId: string;
    existingExternalPrimaryRoomTypeId: string | null;
  }): Promise<{ externalPrimaryRoomTypeId: string }>;
  ensurePrimaryRatePlan(args: {
    externalPropertyId: string;
    externalPrimaryRoomTypeId: string;
    currency: string;
    existingExternalPrimaryRatePlanId: string | null;
  }): Promise<{ externalPrimaryRatePlanId: string }>;
};

export class WhiteLabelAdapterError extends Error {
  constructor(
    readonly code: string,
    readonly retryDisposition: "SAFE_RETRY" | "RECONCILIATION_REQUIRED" = "SAFE_RETRY"
  ) {
    super(code);
    this.name = "WhiteLabelAdapterError";
  }
}

function required(value: string, code: string, max = 255): string {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized.length > max) throw new WhiteLabelAdapterError(code);
  return normalized;
}

function record(value: unknown): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WhiteLabelAdapterError(
      "OTA_PROVIDER_RESPONSE_INVALID",
      "RECONCILIATION_REQUIRED"
    );
  }
  return value as Record<string, any>;
}

function responseId(value: unknown, code: string): string {
  const root = record(value);
  const id = String(root.data?.id ?? "").trim();
  if (!id || id.length > 120) {
    throw new WhiteLabelAdapterError(code, "RECONCILIATION_REQUIRED");
  }
  return id;
}

/**
 * White-label domain boundary. It remains inert unless explicitly enabled and
 * supplied with a transport; environment and network policy live outside it.
 */
export class ChannexWhiteLabelAdapter
  implements WhiteLabelProvisioner, OneTimeConnectionTokenIssuer
{
  constructor(
    private readonly config: {
      enabled: boolean;
      apiKey: string;
      iframeBaseUrl: string;
      channelFilterByProvider: Readonly<
        Partial<Record<ConnectionCenterProvider, string>>
      >;
      transport: WhiteLabelHttpTransport;
    }
  ) {}

  private assertEnabled(): void {
    if (!this.config.enabled) {
      throw new WhiteLabelAdapterError("OTA_CONNECTION_CENTER_RUNTIME_DISABLED");
    }
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    this.assertEnabled();
    const apiKey = required(this.config.apiKey, "OTA_PROVIDER_CREDENTIALS_UNAVAILABLE", 512);
    return this.config.transport.send({
      method: "POST",
      path,
      headers: {
        "user-api-key": apiKey,
        "Content-Type": "application/json",
      },
      body,
    });
  }

  async ensureGroup(args: {
    organizationId: string;
    organizationName: string;
    existingExternalGroupId: string | null;
  }): Promise<ProvisionedGroup> {
    this.assertEnabled();
    if (args.existingExternalGroupId) {
      return { externalGroupId: required(args.existingExternalGroupId, "OTA_EXTERNAL_GROUP_ID_INVALID", 120) };
    }
    const response = await this.post("/api/v1/groups", {
      group: { title: required(args.organizationName, "OTA_ORGANIZATION_NAME_REQUIRED") },
    });
    return { externalGroupId: responseId(response, "OTA_PROVIDER_GROUP_RESPONSE_INVALID") };
  }

  async ensureProperty(args: {
    organizationId: string;
    propertyId: string;
    propertyName: string;
    currency: string;
    timezone: string;
    externalGroupId: string;
    existingExternalPropertyId: string | null;
  }): Promise<{ externalPropertyId: string }> {
    this.assertEnabled();
    if (args.existingExternalPropertyId) {
      return {
        externalPropertyId: required(
          args.existingExternalPropertyId,
          "OTA_EXTERNAL_PROPERTY_ID_INVALID",
          120
        ),
      };
    }
    const propertyResponse = await this.post("/api/v1/properties", {
      property: {
        title: required(args.propertyName, "OTA_PROPERTY_NAME_REQUIRED"),
        group_id: required(args.externalGroupId, "OTA_EXTERNAL_GROUP_ID_INVALID", 120),
        currency: required(args.currency, "OTA_PROPERTY_CURRENCY_REQUIRED", 3).toUpperCase(),
        timezone: required(args.timezone, "OTA_PROPERTY_TIMEZONE_REQUIRED", 120),
      },
    });
    return { externalPropertyId: responseId(
      propertyResponse,
      "OTA_PROVIDER_PROPERTY_RESPONSE_INVALID"
    ) };
  }

  async ensurePrimaryRoomType(args: {
    externalPropertyId: string;
    existingExternalPrimaryRoomTypeId: string | null;
  }): Promise<{ externalPrimaryRoomTypeId: string }> {
    this.assertEnabled();
    if (args.existingExternalPrimaryRoomTypeId) {
      return {
        externalPrimaryRoomTypeId: required(
          args.existingExternalPrimaryRoomTypeId,
          "OTA_EXTERNAL_ROOM_ID_INVALID",
          120
        ),
      };
    }
    const roomResponse = await this.post("/api/v1/room_types", {
      room_type: {
        property_id: required(args.externalPropertyId, "OTA_EXTERNAL_PROPERTY_ID_INVALID", 120),
        title: "Primary accommodation",
        count_of_rooms: 1,
        occ_adults: 2,
      },
    });
    return { externalPrimaryRoomTypeId: responseId(
      roomResponse,
      "OTA_PROVIDER_ROOM_RESPONSE_INVALID"
    ) };
  }

  async ensurePrimaryRatePlan(args: {
    externalPropertyId: string;
    externalPrimaryRoomTypeId: string;
    currency: string;
    existingExternalPrimaryRatePlanId: string | null;
  }): Promise<{ externalPrimaryRatePlanId: string }> {
    this.assertEnabled();
    if (args.existingExternalPrimaryRatePlanId) {
      return {
        externalPrimaryRatePlanId: required(
          args.existingExternalPrimaryRatePlanId,
          "OTA_EXTERNAL_RATE_ID_INVALID",
          120
        ),
      };
    }
    const rateResponse = await this.post("/api/v1/rate_plans", {
      rate_plan: {
        property_id: required(args.externalPropertyId, "OTA_EXTERNAL_PROPERTY_ID_INVALID", 120),
        room_type_id: required(args.externalPrimaryRoomTypeId, "OTA_EXTERNAL_ROOM_ID_INVALID", 120),
        title: "Standard rate",
        currency: required(args.currency, "OTA_PROPERTY_CURRENCY_REQUIRED", 3).toUpperCase(),
      },
    });
    return {
      externalPrimaryRatePlanId: responseId(
        rateResponse,
        "OTA_PROVIDER_RATE_RESPONSE_INVALID"
      ),
    };
  }

  async issue(args: {
    externalGroupId: string;
    externalPropertyId: string;
    provider: ConnectionCenterProvider;
  }): Promise<{ token: string; launchUrl: string }> {
    this.assertEnabled();
    const channelFilter = required(
      this.config.channelFilterByProvider[args.provider] ?? "",
      "OTA_CONNECTION_CHANNEL_FILTER_UNAVAILABLE",
      120
    );
    const response = record(await this.post("/api/v1/auth/one_time_token", {
      one_time_token: {
        group_id: required(args.externalGroupId, "OTA_EXTERNAL_GROUP_ID_INVALID", 120),
        property_id: required(args.externalPropertyId, "OTA_EXTERNAL_PROPERTY_ID_INVALID", 120),
      },
    }));
    const token = String(
      response.data?.attributes?.token ?? response.data?.token ?? ""
    ).trim();
    if (!token || token.length > 4096) {
      throw new WhiteLabelAdapterError(
        "OTA_CONNECTION_TOKEN_INVALID",
        "RECONCILIATION_REQUIRED"
      );
    }
    const baseUrl = required(this.config.iframeBaseUrl, "OTA_CONNECTION_IFRAME_URL_INVALID");
    const launchUrl = new URL(baseUrl);
    launchUrl.searchParams.set("one_time_token", token);
    launchUrl.searchParams.set("channels_filter", channelFilter);
    return { token, launchUrl: launchUrl.toString() };
  }
}
