const ALLOWED_API_ORIGINS = new Set([
  "https://app.channex.io",
  "https://staging.channex.io",
]);

const MAX_RESPONSE_BYTES = 1_000_000;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class AirbnbListingDiscoveryTransportError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "AirbnbListingDiscoveryTransportError";
  }
}

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
    throw new AirbnbListingDiscoveryTransportError(
      "OTA_AIRBNB_LISTING_DISCOVERY_API_ORIGIN_INVALID"
    );
  }
}

function safeChannelId(value: string): string {
  const id = String(value ?? "").trim();
  if (!UUID.test(id)) {
    throw new AirbnbListingDiscoveryTransportError(
      "OTA_AIRBNB_CHANNEL_ID_INVALID"
    );
  }
  return id;
}

function failure(status: number): AirbnbListingDiscoveryTransportError {
  if (status === 404) {
    return new AirbnbListingDiscoveryTransportError(
      "OTA_AIRBNB_LISTING_DISCOVERY_NOT_FOUND"
    );
  }
  if (status === 429) {
    return new AirbnbListingDiscoveryTransportError(
      "OTA_AIRBNB_LISTING_DISCOVERY_RATE_LIMITED"
    );
  }
  if (status >= 400 && status < 500) {
    return new AirbnbListingDiscoveryTransportError(
      "OTA_AIRBNB_LISTING_DISCOVERY_REQUEST_REJECTED"
    );
  }
  return new AirbnbListingDiscoveryTransportError(
    "OTA_AIRBNB_LISTING_DISCOVERY_PROVIDER_UNAVAILABLE"
  );
}

export function createAirbnbListingDiscoveryHttpTransport(args: {
  apiOrigin: string;
  apiKey: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}) {
  const origin = exactOrigin(args.apiOrigin);
  const apiKey = String(args.apiKey ?? "").trim();
  if (!/^[\x21-\x7E]{1,512}$/.test(apiKey)) {
    throw new AirbnbListingDiscoveryTransportError(
      "OTA_AIRBNB_LISTING_DISCOVERY_CREDENTIALS_UNAVAILABLE"
    );
  }
  if (
    !Number.isInteger(args.timeoutMs) ||
    args.timeoutMs < 1_000 ||
    args.timeoutMs > 15_000
  ) {
    throw new AirbnbListingDiscoveryTransportError(
      "OTA_AIRBNB_LISTING_DISCOVERY_TIMEOUT_CONFIGURATION_INVALID"
    );
  }
  const fetchImpl = args.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new AirbnbListingDiscoveryTransportError(
      "OTA_AIRBNB_LISTING_DISCOVERY_TRANSPORT_UNAVAILABLE"
    );
  }

  return {
    async listAirbnbListings(channelId: string): Promise<unknown> {
      const id = safeChannelId(channelId);
      const url = new URL(
        `/api/v1/channels/${encodeURIComponent(id)}/action/listings`,
        origin
      );
      if (url.origin !== origin) {
        throw new AirbnbListingDiscoveryTransportError(
          "OTA_AIRBNB_LISTING_DISCOVERY_REQUEST_NOT_ALLOWED"
        );
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), args.timeoutMs);
      try {
        let response: Response;
        try {
          response = await fetchImpl(url, {
            method: "GET",
            headers: {
              Accept: "application/json",
              "user-api-key": apiKey,
            },
            redirect: "error",
            signal: controller.signal,
          });
        } catch {
          throw new AirbnbListingDiscoveryTransportError(
            "OTA_AIRBNB_LISTING_DISCOVERY_PROVIDER_UNAVAILABLE"
          );
        }
        if (!response.ok) throw failure(response.status);

        const contentLength = Number(
          response.headers.get("content-length") ?? 0
        );
        if (
          Number.isFinite(contentLength) &&
          contentLength > MAX_RESPONSE_BYTES
        ) {
          throw new AirbnbListingDiscoveryTransportError(
            "OTA_AIRBNB_LISTING_DISCOVERY_RESPONSE_TOO_LARGE"
          );
        }
        const text = await response.text();
        if (text.length > MAX_RESPONSE_BYTES) {
          throw new AirbnbListingDiscoveryTransportError(
            "OTA_AIRBNB_LISTING_DISCOVERY_RESPONSE_TOO_LARGE"
          );
        }
        try {
          return JSON.parse(text) as unknown;
        } catch {
          throw new AirbnbListingDiscoveryTransportError(
            "OTA_AIRBNB_LISTING_DISCOVERY_RESPONSE_INVALID"
          );
        }
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}
