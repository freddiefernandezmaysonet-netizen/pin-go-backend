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
  getRoomType(roomTypeId: string): Promise<unknown>;
  getRatePlan(ratePlanId: string): Promise<unknown>;
  listChannels(propertyId: string, channel?: string): Promise<unknown>;
  getChannel(channelId: string): Promise<unknown>;
  listAirbnbListings(channelId: string): Promise<unknown>;
};

const CHANNEL_PAGE_LIMIT = 100;
const MAX_CHANNEL_PAGES = 100;
const MAX_CHANNEL_RESOURCES = 1_000;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_CHANNEL_FILTER = /^[A-Za-z0-9._:-]{1,120}$/;

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

function safeUuid(value: string, code: string): string {
  const result = String(value ?? "").trim();
  if (!UUID.test(result)) {
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

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function requiredInteger(
  value: unknown,
  minimum: number,
  maximum: number
): number | null {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= minimum &&
    value <= maximum
    ? value
    : null;
}

function optionalChannelFilter(value: string | undefined): string | null {
  if (value === undefined) return null;
  const result = String(value).trim();
  if (!SAFE_CHANNEL_FILTER.test(result)) {
    throw new ChannexReadonlyTransportError(
      "OTA_READONLY_CHANNEL_FILTER_INVALID"
    );
  }
  return result;
}

function requiredMetadataText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const result = value.trim();
  return result && result.length <= 120 ? result : null;
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

  async function listAllChannels(
    propertyId: string,
    channel: string | null
  ): Promise<unknown> {
    const resources: unknown[] = [];
    const resourceIds = new Set<string>();
    let expectedTotal: number | null = null;
    let expectedOrderBy: string | null = null;
    let expectedOrderDirection: "asc" | "desc" | null = null;

    for (let page = 1; page <= MAX_CHANNEL_PAGES; page += 1) {
      const payload = await get(
        "/api/v1/channels",
        new URLSearchParams({
          "filter[property_id]": propertyId,
          ...(channel ? { "filter[channel]": channel } : {}),
          "pagination[page]": String(page),
          "pagination[limit]": String(CHANNEL_PAGE_LIMIT),
        })
      );
      const root = record(payload);
      if (!root || !Array.isArray(root.data)) {
        throw new ChannexReadonlyTransportError(
          "OTA_READONLY_PROVIDER_RESPONSE_INVALID"
        );
      }
      if (root.data.length > CHANNEL_PAGE_LIMIT) {
        throw new ChannexReadonlyTransportError(
          "OTA_READONLY_PROVIDER_RESPONSE_TOO_LARGE"
        );
      }

      const meta = record(root.meta);
      const reportedTotal = requiredInteger(
        meta?.total,
        0,
        MAX_CHANNEL_RESOURCES
      );
      const reportedPage = requiredInteger(meta?.page, 1, MAX_CHANNEL_PAGES);
      const reportedLimit = requiredInteger(
        meta?.limit,
        1,
        CHANNEL_PAGE_LIMIT
      );
      const reportedOrderBy = requiredMetadataText(meta?.order_by);
      const reportedOrderDirection =
        meta?.order_direction === "asc" || meta?.order_direction === "desc"
          ? meta.order_direction
          : null;
      if (
        reportedTotal === null ||
        reportedPage !== page ||
        reportedLimit !== CHANNEL_PAGE_LIMIT ||
        reportedOrderBy === null ||
        reportedOrderDirection === null
      ) {
        throw new ChannexReadonlyTransportError(
          "OTA_READONLY_PROVIDER_RESPONSE_INVALID"
        );
      }
      if (expectedTotal !== null && expectedTotal !== reportedTotal) {
        throw new ChannexReadonlyTransportError(
          "OTA_READONLY_PROVIDER_RESPONSE_INVALID"
        );
      }
      if (
        (expectedOrderBy !== null && expectedOrderBy !== reportedOrderBy) ||
        (expectedOrderDirection !== null &&
          expectedOrderDirection !== reportedOrderDirection)
      ) {
        throw new ChannexReadonlyTransportError(
          "OTA_READONLY_PROVIDER_RESPONSE_INVALID"
        );
      }
      expectedTotal = reportedTotal;
      expectedOrderBy = reportedOrderBy;
      expectedOrderDirection = reportedOrderDirection;

      for (const value of root.data) {
        const resource = record(value);
        const resourceId = String(resource?.id ?? "").trim();
        if (
          !resource ||
          !UUID.test(resourceId) ||
          resourceIds.has(resourceId)
        ) {
          throw new ChannexReadonlyTransportError(
            "OTA_READONLY_PROVIDER_RESPONSE_INVALID"
          );
        }
        resourceIds.add(resourceId);
      }
      resources.push(...root.data);
      if (resources.length > MAX_CHANNEL_RESOURCES) {
        throw new ChannexReadonlyTransportError(
          "OTA_READONLY_PROVIDER_RESPONSE_TOO_LARGE"
        );
      }
      if (expectedTotal !== null && resources.length > expectedTotal) {
        throw new ChannexReadonlyTransportError(
          "OTA_READONLY_PROVIDER_RESPONSE_INVALID"
        );
      }

      const completeByTotal = resources.length === expectedTotal;
      if (completeByTotal) {
        return {
          data: resources,
          meta: {
            ...(meta ?? {}),
            page: 1,
            limit: CHANNEL_PAGE_LIMIT,
            total: resources.length,
            order_by: expectedOrderBy,
            order_direction: expectedOrderDirection,
          },
        };
      }
      if (
        root.data.length === 0 ||
        root.data.length < CHANNEL_PAGE_LIMIT
      ) {
        throw new ChannexReadonlyTransportError(
          "OTA_READONLY_PROVIDER_RESPONSE_INVALID"
        );
      }
    }

    throw new ChannexReadonlyTransportError(
      "OTA_READONLY_PROVIDER_RESPONSE_TOO_LARGE"
    );
  }

  return {
    getProperty(propertyId) {
      const id = safeUuid(propertyId, "OTA_READONLY_PROPERTY_ID_INVALID");
      return get(`/api/v1/properties/${encodeURIComponent(id)}`);
    },
    listRoomTypes(propertyId) {
      const id = safeUuid(propertyId, "OTA_READONLY_PROPERTY_ID_INVALID");
      return get("/api/v1/room_types", new URLSearchParams({ "filter[property_id]": id }));
    },
    listRatePlans(propertyId) {
      const id = safeUuid(propertyId, "OTA_READONLY_PROPERTY_ID_INVALID");
      return get("/api/v1/rate_plans", new URLSearchParams({ "filter[property_id]": id }));
    },
    getRoomType(roomTypeId) {
      const id = safeUuid(roomTypeId, "OTA_READONLY_ROOM_TYPE_ID_INVALID");
      return get(`/api/v1/room_types/${encodeURIComponent(id)}`);
    },
    getRatePlan(ratePlanId) {
      const id = safeUuid(ratePlanId, "OTA_READONLY_RATE_PLAN_ID_INVALID");
      return get(`/api/v1/rate_plans/${encodeURIComponent(id)}`);
    },
    listChannels(propertyId, channel) {
      const id = safeUuid(propertyId, "OTA_READONLY_PROPERTY_ID_INVALID");
      return listAllChannels(id, optionalChannelFilter(channel));
    },
    getChannel(channelId) {
      const id = safeUuid(channelId, "OTA_READONLY_CHANNEL_ID_INVALID");
      return get(`/api/v1/channels/${encodeURIComponent(id)}`);
    },
    listAirbnbListings(channelId) {
      const id = safeUuid(channelId, "OTA_READONLY_CHANNEL_ID_INVALID");
      return get(`/api/v1/channels/${encodeURIComponent(id)}/action/listings`);
    },
  };
}
