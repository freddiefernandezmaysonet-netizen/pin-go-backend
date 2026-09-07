const ALLOWED_API_ORIGINS = new Set([
  "https://app.channex.io",
  "https://staging.channex.io",
]);

export class ChannexReadonlyTransportError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ChannexReadonlyTransportError";
  }
}

export type ChannexReadonlyTransport = {
  getProperty(propertyId: string): Promise<unknown>;
  listRoomTypes(propertyId: string): Promise<unknown>;
  listRatePlans(propertyId: string): Promise<unknown>;
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
    throw new ChannexReadonlyTransportError("OTA_READONLY_PROVIDER_API_ORIGIN_INVALID");
  }
}

function safeId(value: string, code: string): string {
  const result = String(value ?? "").trim();
  if (!/^[A-Za-z0-9_-]{1,120}$/.test(result)) {
    throw new ChannexReadonlyTransportError(code);
  }
  return result;
}

function failure(status: number): ChannexReadonlyTransportError {
  if (status === 404) return new ChannexReadonlyTransportError("OTA_READONLY_RESOURCE_NOT_FOUND");
  if (status === 429) return new ChannexReadonlyTransportError("OTA_READONLY_PROVIDER_RATE_LIMITED");
  if (status >= 400 && status < 500) {
    return new ChannexReadonlyTransportError("OTA_READONLY_PROVIDER_REQUEST_REJECTED");
  }
  return new ChannexReadonlyTransportError("OTA_READONLY_PROVIDER_UNAVAILABLE");
}

export function createChannexReadonlyHttpTransport(args: {
  apiOrigin: string;
  apiKey: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}): ChannexReadonlyTransport {
  const origin = exactOrigin(args.apiOrigin);
  const apiKey = String(args.apiKey ?? "").trim();
  if (!/^[\x21-\x7E]{1,512}$/.test(apiKey)) {
    throw new ChannexReadonlyTransportError("OTA_READONLY_PROVIDER_CREDENTIALS_UNAVAILABLE");
  }
  if (!Number.isInteger(args.timeoutMs) || args.timeoutMs < 1_000 || args.timeoutMs > 15_000) {
    throw new ChannexReadonlyTransportError("OTA_READONLY_PROVIDER_TIMEOUT_CONFIGURATION_INVALID");
  }
  const fetchImpl = args.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new ChannexReadonlyTransportError("OTA_READONLY_PROVIDER_TRANSPORT_UNAVAILABLE");
  }

  async function get(pathname: string, search?: URLSearchParams): Promise<unknown> {
    const url = new URL(pathname, origin);
    if (url.origin !== origin || !pathname.startsWith("/api/v1/")) {
      throw new ChannexReadonlyTransportError("OTA_READONLY_PROVIDER_REQUEST_NOT_ALLOWED");
    }
    if (search) url.search = search.toString();

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), args.timeoutMs);
    try {
      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: "GET",
          headers: { Accept: "application/json", "user-api-key": apiKey },
          redirect: "error",
          signal: controller.signal,
        });
      } catch {
        throw new ChannexReadonlyTransportError("OTA_READONLY_PROVIDER_UNAVAILABLE");
      }
      if (!response.ok) throw failure(response.status);
      const contentLength = Number(response.headers.get("content-length") ?? 0);
      if (Number.isFinite(contentLength) && contentLength > 1_000_000) {
        throw new ChannexReadonlyTransportError("OTA_READONLY_PROVIDER_RESPONSE_TOO_LARGE");
      }
      const text = await response.text();
      if (text.length > 1_000_000) {
        throw new ChannexReadonlyTransportError("OTA_READONLY_PROVIDER_RESPONSE_TOO_LARGE");
      }
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new ChannexReadonlyTransportError("OTA_READONLY_PROVIDER_RESPONSE_INVALID");
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    getProperty(propertyId) {
      const id = safeId(propertyId, "OTA_READONLY_PROPERTY_ID_INVALID");
      return get(`/api/v1/properties/${encodeURIComponent(id)}`);
    },
    listRoomTypes(propertyId) {
      const id = safeId(propertyId, "OTA_READONLY_PROPERTY_ID_INVALID");
      return get("/api/v1/room_types", new URLSearchParams({ "filter[property_id]": id }));
    },
    listRatePlans(propertyId) {
      const id = safeId(propertyId, "OTA_READONLY_PROPERTY_ID_INVALID");
      return get("/api/v1/rate_plans", new URLSearchParams({ "filter[property_id]": id }));
    },
  };
}
