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
  ensurePropertyInventory(args: {
    organizationId: string;
    propertyId: string;
    propertyName: string;
    currency: string;
    timezone: string;
    externalGroupId: string;
    existingExternalPropertyId: string | null;
  }): Promise<ProvisionedPropertyInventory>;
};

export class WhiteLabelAdapterError extends Error {
  constructor(readonly code: string) {
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
    throw new WhiteLabelAdapterError("OTA_PROVIDER_RESPONSE_INVALID");
  }
  return value as Record<string, any>;
}

function responseId(value: unknown, code: string): string {
  const root = record(value);
  return required(String(root.data?.id ?? ""), code, 120);
}

/**
 * Transport-only white-label boundary. It is inert unless both `enabled` and
 * an injected transport are supplied. The application runtime never creates a
 * network transport in this delivery stage.
 */
export class ChannexWhiteLabelAdapter
  implements WhiteLabelProvisioner, OneTimeConnectionTokenIssuer
{
  constructor(
    private readonly config: {
      enabled: boolean;
      apiKey: string;
      iframeBaseUrl: string;
      transport: WhiteLabelHttpTransport;
    }
  ) {}

  private async post(path: string, body: unknown): Promise<unknown> {
    if (!this.config.enabled) {
      throw new WhiteLabelAdapterError("OTA_CONNECTION_CENTER_RUNTIME_DISABLED");
    }
    const apiKey = required(this.config.apiKey, "OTA_PROVIDER_CREDENTIALS_UNAVAILABLE", 512);
    return this.config.transport.send({
      method: "POST",
      path,
      headers: {
        Authorization: `Bearer ${apiKey}`,
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
    if (args.existingExternalGroupId) {
      return { externalGroupId: required(args.existingExternalGroupId, "OTA_EXTERNAL_GROUP_ID_INVALID", 120) };
    }
    const response = await this.post("/api/v1/groups", {
      group: { title: required(args.organizationName, "OTA_ORGANIZATION_NAME_REQUIRED") },
    });
    return { externalGroupId: responseId(response, "OTA_PROVIDER_GROUP_RESPONSE_INVALID") };
  }

  async ensurePropertyInventory(args: {
    organizationId: string;
    propertyId: string;
    propertyName: string;
    currency: string;
    timezone: string;
    externalGroupId: string;
    existingExternalPropertyId: string | null;
  }): Promise<ProvisionedPropertyInventory> {
    if (args.existingExternalPropertyId) {
      throw new WhiteLabelAdapterError("OTA_PROVIDER_INVENTORY_RECONCILIATION_REQUIRED");
    }
    const propertyResponse = await this.post("/api/v1/properties", {
      property: {
        title: required(args.propertyName, "OTA_PROPERTY_NAME_REQUIRED"),
        group_id: required(args.externalGroupId, "OTA_EXTERNAL_GROUP_ID_INVALID", 120),
        currency: required(args.currency, "OTA_PROPERTY_CURRENCY_REQUIRED", 3).toUpperCase(),
        timezone: required(args.timezone, "OTA_PROPERTY_TIMEZONE_REQUIRED", 120),
      },
    });
    const externalPropertyId = responseId(
      propertyResponse,
      "OTA_PROVIDER_PROPERTY_RESPONSE_INVALID"
    );
    const roomResponse = await this.post("/api/v1/room_types", {
      room_type: {
        property_id: externalPropertyId,
        title: "Primary accommodation",
        count_of_rooms: 1,
        occ_adults: 2,
      },
    });
    const externalPrimaryRoomTypeId = responseId(
      roomResponse,
      "OTA_PROVIDER_ROOM_RESPONSE_INVALID"
    );
    const rateResponse = await this.post("/api/v1/rate_plans", {
      rate_plan: {
        property_id: externalPropertyId,
        room_type_id: externalPrimaryRoomTypeId,
        title: "Standard rate",
        currency: required(args.currency, "OTA_PROPERTY_CURRENCY_REQUIRED", 3).toUpperCase(),
      },
    });
    return {
      externalPropertyId,
      externalPrimaryRoomTypeId,
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
    const response = record(await this.post("/api/v1/auth/one_time_token", {
      one_time_token: {
        group_id: required(args.externalGroupId, "OTA_EXTERNAL_GROUP_ID_INVALID", 120),
        property_id: required(args.externalPropertyId, "OTA_EXTERNAL_PROPERTY_ID_INVALID", 120),
      },
    }));
    const token = required(
      String(response.data?.attributes?.token ?? response.data?.token ?? ""),
      "OTA_CONNECTION_TOKEN_INVALID",
      4096
    );
    const baseUrl = required(this.config.iframeBaseUrl, "OTA_CONNECTION_IFRAME_URL_INVALID");
    const launchUrl = new URL(baseUrl);
    launchUrl.searchParams.set("one_time_token", token);
    launchUrl.searchParams.set("channels_filter", args.provider);
    return { token, launchUrl: launchUrl.toString() };
  }
}
