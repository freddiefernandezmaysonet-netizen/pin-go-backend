const ALLOWED_API_ORIGINS = new Set([
  "https://app.channex.io",
  "https://staging.channex.io",
]);
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_RESPONSE_BYTES = 1_000_000;

export class AirbnbListingsHttpTransportError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "AirbnbListingsHttpTransportError";
  }
}

function exactOrigin(value: string): string {
  try {
    const parsed = new URL(String(value ?? "").trim());
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
    throw new AirbnbListingsHttpTransportError(
      "OTA_AIRBNB_LISTINGS_PROVIDER_ORIGIN_INVALID"
    );
  }
}

function safeUuid(value: string): string {
  const result = String(value ?? "").trim();
  if (!UUID.test(result)) {
    throw new AirbnbListingsHttpTransportError("OTA_AIRBNB_CHANNEL_ID_INVALID");
  }
  return result;
}

function failure(status: number): AirbnbListingsHttpTransportError {
  if (status === 401 || status === 403) {
    return new AirbnbListingsHttpTransportError(
      "OTA_AIRBNB_LISTINGS_PROVIDER_FORBIDDEN"
    );
  }
  if (status === 404) {
    return new AirbnbListingsHttpTransportError(
      "OTA_AIRBNB_LISTINGS_RESOURCE_NOT_FOUND"
    );
  }
  if (status === 400 || status === 422) {
    return new AirbnbListingsHttpTransportError(
      "OTA_AIRBNB_LISTINGS_REQUEST_REJECTED"
    );
  }
  return new AirbnbListingsHttpTransportError(
    "OTA_AIRBNB_LISTINGS_PROVIDER_UNAVAILABLE"
  );
}

export function createAirbnbHostSelfServiceListingsHttpTransport(args: {
  apiOrigin: string;
  apiKey: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}): { listListings(channelId: string): Promise<unknown> } {
  const origin = exactOrigin(args.apiOrigin);
  const apiKey = String(args.apiKey ?? "").trim();
  if (!/^[\x21-\x7E]{1,512}$/.test(apiKey)) {
    throw new AirbnbListingsHttpTransportError(
      "OTA_AIRBNB_LISTINGS_PROVIDER_CREDENTIALS_UNAVAILABLE"
    );
  }
  if (
    !Number.isInteger(args.timeoutMs) ||
    args.timeoutMs < 1_000 ||
    args.timeoutMs > 15_000
  ) {
    throw new AirbnbListingsHttpTransportError(
      "OTA_AIRBNB_LISTINGS_PROVIDER_TIMEOUT_CONFIGURATION_INVALID"
    );
  }
  const fetchImpl = args.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new AirbnbListingsHttpTransportError(
      "OTA_AIRBNB_LISTINGS_PROVIDER_TRANSPORT_UNAVAILABLE"
    );
  }

  return {
    async listListings(channelId) {
      const id = safeUuid(channelId);
      const pathname = `/api/v1/channels/${encodeURIComponent(id)}/action/listings`;
      const url = new URL(pathname, origin);
      if (url.origin !== origin || url.pathname !== pathname) {
        throw new AirbnbListingsHttpTransportError(
          "OTA_AIRBNB_LISTINGS_PROVIDER_REQUEST_NOT_ALLOWED"
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
          throw new AirbnbListingsHttpTransportError(
            "OTA_AIRBNB_LISTINGS_PROVIDER_UNAVAILABLE"
          );
        }
        if (!response.ok) throw failure(response.status);

        const contentLength = Number(response.headers.get("content-length") ?? 0);
        if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
          throw new AirbnbListingsHttpTransportError(
            "OTA_AIRBNB_LISTINGS_PROVIDER_RESPONSE_TOO_LARGE"
          );
        }
        const text = await response.text();
        if (text.length > MAX_RESPONSE_BYTES) {
          throw new AirbnbListingsHttpTransportError(
            "OTA_AIRBNB_LISTINGS_PROVIDER_RESPONSE_TOO_LARGE"
          );
        }
        try {
          return JSON.parse(text) as unknown;
        } catch {
          throw new AirbnbListingsHttpTransportError(
            "OTA_AIRBNB_LISTINGS_PROVIDER_RESPONSE_INVALID"
          );
        }
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}
