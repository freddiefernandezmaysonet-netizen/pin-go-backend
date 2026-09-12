const ALLOWED_API_ORIGINS = new Set([
  "https://app.channex.io",
  "https://staging.channex.io",
]);

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const AIRBNB_LISTING_ID = /^\d{1,32}$/;
const MAX_RESPONSE_BYTES = 1_000_000;

export class AirbnbHostConfirmedMappingTransportError extends Error {
  constructor(
    readonly code: string,
    readonly retryDisposition: "SAFE_RETRY" | "RECONCILIATION_REQUIRED",
    readonly providerStatus: number | null = null
  ) {
    super(code);
    this.name = "AirbnbHostConfirmedMappingTransportError";
  }
}

export type AirbnbHostConfirmedMappingTransport = {
  createMapping(args: {
    channelId: string;
    ratePlanId: string;
    listingId: string;
  }): Promise<unknown>;
};

function exactOrigin(raw: string): string {
  try {
    const parsed = new URL(String(raw ?? "").trim());
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash ||
      !ALLOWED_API_ORIGINS.has(parsed.origin)
    ) {
      throw new Error("invalid");
    }
    return parsed.origin;
  } catch {
    throw new AirbnbHostConfirmedMappingTransportError(
      "OTA_AIRBNB_MAPPING_API_ORIGIN_INVALID",
      "SAFE_RETRY"
    );
  }
}

function safeUuid(value: string, code: string): string {
  const normalized = String(value ?? "").trim();
  if (!UUID.test(normalized)) {
    throw new AirbnbHostConfirmedMappingTransportError(code, "SAFE_RETRY");
  }
  return normalized;
}

function safeListingId(value: string): string {
  const normalized = String(value ?? "").trim();
  if (!AIRBNB_LISTING_ID.test(normalized)) {
    throw new AirbnbHostConfirmedMappingTransportError(
      "OTA_AIRBNB_MAPPING_LISTING_ID_INVALID",
      "SAFE_RETRY"
    );
  }
  return normalized;
}

function failure(status: number): AirbnbHostConfirmedMappingTransportError {
  if (status === 404) {
    return new AirbnbHostConfirmedMappingTransportError(
      "OTA_AIRBNB_MAPPING_RESOURCE_NOT_FOUND",
      "SAFE_RETRY",
      status
    );
  }
  if (status === 429) {
    return new AirbnbHostConfirmedMappingTransportError(
      "OTA_AIRBNB_MAPPING_RATE_LIMITED",
      "SAFE_RETRY",
      status
    );
  }
  if (status >= 400 && status < 500) {
    return new AirbnbHostConfirmedMappingTransportError(
      "OTA_AIRBNB_MAPPING_REQUEST_REJECTED",
      "SAFE_RETRY",
      status
    );
  }
  return new AirbnbHostConfirmedMappingTransportError(
    "OTA_AIRBNB_MAPPING_RECONCILIATION_REQUIRED",
    "RECONCILIATION_REQUIRED",
    status
  );
}

export function createAirbnbHostConfirmedMappingHttpTransport(args: {
  apiOrigin: string;
  apiKey: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}): AirbnbHostConfirmedMappingTransport {
  const origin = exactOrigin(args.apiOrigin);
  const apiKey = String(args.apiKey ?? "").trim();
  if (!/^[\x21-\x7E]{1,512}$/.test(apiKey)) {
    throw new AirbnbHostConfirmedMappingTransportError(
      "OTA_AIRBNB_MAPPING_CREDENTIALS_UNAVAILABLE",
      "SAFE_RETRY"
    );
  }
  if (
    !Number.isInteger(args.timeoutMs) ||
    args.timeoutMs < 1_000 ||
    args.timeoutMs > 15_000
  ) {
    throw new AirbnbHostConfirmedMappingTransportError(
      "OTA_AIRBNB_MAPPING_TIMEOUT_CONFIGURATION_INVALID",
      "SAFE_RETRY"
    );
  }
  const fetchImpl = args.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new AirbnbHostConfirmedMappingTransportError(
      "OTA_AIRBNB_MAPPING_TRANSPORT_UNAVAILABLE",
      "SAFE_RETRY"
    );
  }

  return {
    async createMapping({ channelId, ratePlanId, listingId }) {
      const safeChannelId = safeUuid(
        channelId,
        "OTA_AIRBNB_MAPPING_CHANNEL_ID_INVALID"
      );
      const safeRatePlanId = safeUuid(
        ratePlanId,
        "OTA_AIRBNB_MAPPING_RATE_PLAN_ID_INVALID"
      );
      const safeAirbnbListingId = safeListingId(listingId);
      const pathname = `/api/v1/channels/${encodeURIComponent(
        safeChannelId
      )}/mappings`;
      const url = new URL(pathname, origin);
      if (url.origin !== origin || url.pathname !== pathname) {
        throw new AirbnbHostConfirmedMappingTransportError(
          "OTA_AIRBNB_MAPPING_REQUEST_NOT_ALLOWED",
          "SAFE_RETRY"
        );
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), args.timeoutMs);
      try {
        let response: Response;
        try {
          response = await fetchImpl(url, {
            method: "POST",
            headers: {
              Accept: "application/json",
              "Content-Type": "application/json",
              "user-api-key": apiKey,
            },
            redirect: "error",
            signal: controller.signal,
            body: JSON.stringify({
              mapping: {
                rate_plan_id: safeRatePlanId,
                settings: { listing_id: safeAirbnbListingId },
              },
            }),
          });
        } catch {
          throw new AirbnbHostConfirmedMappingTransportError(
            "OTA_AIRBNB_MAPPING_RECONCILIATION_REQUIRED",
            "RECONCILIATION_REQUIRED"
          );
        }
        if (!response.ok) throw failure(response.status);

        const contentLength = Number(response.headers.get("content-length") ?? 0);
        if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
          throw new AirbnbHostConfirmedMappingTransportError(
            "OTA_AIRBNB_MAPPING_RESPONSE_TOO_LARGE",
            "RECONCILIATION_REQUIRED",
            response.status
          );
        }
        const text = await response.text();
        if (text.length > MAX_RESPONSE_BYTES) {
          throw new AirbnbHostConfirmedMappingTransportError(
            "OTA_AIRBNB_MAPPING_RESPONSE_TOO_LARGE",
            "RECONCILIATION_REQUIRED",
            response.status
          );
        }
        try {
          return JSON.parse(text) as unknown;
        } catch {
          throw new AirbnbHostConfirmedMappingTransportError(
            "OTA_AIRBNB_MAPPING_RESPONSE_INVALID",
            "RECONCILIATION_REQUIRED",
            response.status
          );
        }
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}
