import { createHash } from "node:crypto";

export const AIRBNB_LIFECYCLE_WEBHOOK_CALLBACK_PATH =
  "/webhooks/ota/channex/channel-lifecycle" as const;
export const AIRBNB_LIFECYCLE_WEBHOOK_SECRET_HEADER =
  "x-pin-go-ota-channel-webhook-secret" as const;
export const AIRBNB_LIFECYCLE_WEBHOOK_EVENTS = [
  "new_channel",
  "updated_channel",
  "activate_channel",
  "deactivate_channel",
  "disconnected_channel",
  "disconnect_listing",
] as const;
export const AIRBNB_LIFECYCLE_WEBHOOK_EVENT_MASK =
  AIRBNB_LIFECYCLE_WEBHOOK_EVENTS.join(";");

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ALLOWED_ORIGIN = "https://app.channex.io";
const WEBHOOK_PAGE_LIMIT = 100;
const MAX_WEBHOOK_PAGES = 100;
const MAX_WEBHOOK_RESOURCES = 10_000;

export class AirbnbLifecycleWebhookError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "AirbnbLifecycleWebhookError";
  }
}

export type AirbnbLifecycleWebhookSnapshot = {
  id: string;
  propertyId: string;
  callbackUrl: string;
  eventMask: string;
  headers: Readonly<Record<string, string>>;
  isActive: boolean;
  sendData: boolean;
};

export type AirbnbLifecycleWebhookEnsureResult = {
  status: "CREATED" | "UPDATED" | "UNCHANGED";
  webhookId: string;
  providerMutations: 0 | 1;
};

function exactOrigin(value: unknown): string {
  try {
    const url = new URL(String(value ?? "").trim());
    if (
      url.origin !== ALLOWED_ORIGIN ||
      url.href.replace(/\/$/, "") !== url.origin
    ) {
      throw new Error("invalid");
    }
    return url.origin;
  } catch {
    throw new AirbnbLifecycleWebhookError(
      "AIRBNB_LIFECYCLE_WEBHOOK_PROVIDER_ORIGIN_INVALID"
    );
  }
}

function requiredUuid(value: unknown, code: string): string {
  const result = String(value ?? "").trim();
  if (!UUID.test(result)) throw new AirbnbLifecycleWebhookError(code);
  return result;
}

function requiredSecret(value: unknown): string {
  const result = String(value ?? "").trim();
  if (!/^[\x21-\x7E]{32,512}$/.test(result)) {
    throw new AirbnbLifecycleWebhookError(
      "AIRBNB_LIFECYCLE_WEBHOOK_SECRET_INVALID"
    );
  }
  return result;
}

function callbackUrl(value: unknown): string {
  try {
    const url = new URL(String(value ?? "").trim());
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.pathname !== AIRBNB_LIFECYCLE_WEBHOOK_CALLBACK_PATH ||
      url.search ||
      url.hash
    ) {
      throw new Error("invalid");
    }
    return `${url.origin}${url.pathname}`;
  } catch {
    throw new AirbnbLifecycleWebhookError(
      "AIRBNB_LIFECYCLE_WEBHOOK_CALLBACK_INVALID"
    );
  }
}

function record(value: unknown): Record<string, any> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, any>)
    : null;
}

function stringRecord(value: unknown): Record<string, string> {
  const input = record(value);
  if (!input) return {};
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(input)) {
    if (typeof item === "string") out[key] = item;
  }
  return out;
}

function parseWebhook(value: unknown): AirbnbLifecycleWebhookSnapshot {
  const resource = record(value);
  const attributes = record(resource?.attributes);
  const relationships = record(resource?.relationships);
  const propertyRel = record(record(relationships?.property)?.data);
  const id = requiredUuid(
    resource?.id,
    "AIRBNB_LIFECYCLE_WEBHOOK_RESPONSE_ID_INVALID"
  );
  const propertyId = requiredUuid(
    attributes?.property_id ?? propertyRel?.id,
    "AIRBNB_LIFECYCLE_WEBHOOK_RESPONSE_PROPERTY_INVALID"
  );
  if (
    resource?.type !== "webhook" ||
    typeof attributes?.callback_url !== "string" ||
    typeof attributes?.event_mask !== "string" ||
    typeof attributes?.is_active !== "boolean" ||
    typeof attributes?.send_data !== "boolean"
  ) {
    throw new AirbnbLifecycleWebhookError(
      "AIRBNB_LIFECYCLE_WEBHOOK_RESPONSE_INVALID"
    );
  }
  return {
    id,
    propertyId,
    callbackUrl: String(attributes.callback_url).trim(),
    eventMask: String(attributes.event_mask).trim().toLowerCase(),
    headers: stringRecord(attributes.headers),
    isActive: attributes.is_active,
    sendData: attributes.send_data,
  };
}

function eventMaskParts(value: string): string[] | null {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw || raw === "*") return null;
  const parts = raw.split(";").map((item) => item.trim());
  if (
    parts.some((item) => !item) ||
    new Set(parts).size !== parts.length
  ) {
    return null;
  }
  return parts;
}

function eventMaskWithinLifecycleScope(value: string): boolean {
  const parts = eventMaskParts(value);
  return Boolean(
    parts &&
      parts.every((event) =>
        (AIRBNB_LIFECYCLE_WEBHOOK_EVENTS as readonly string[]).includes(event)
      )
  );
}

function sameEventMask(value: string): boolean {
  const parts = eventMaskParts(value);
  return Boolean(
    parts &&
      parts.length === AIRBNB_LIFECYCLE_WEBHOOK_EVENTS.length &&
      AIRBNB_LIFECYCLE_WEBHOOK_EVENTS.every((event) => parts.includes(event))
  );
}

function secretMatches(headers: Readonly<Record<string, string>>, secret: string) {
  const received = Object.entries(headers).find(
    ([key]) => key.toLowerCase() === AIRBNB_LIFECYCLE_WEBHOOK_SECRET_HEADER
  )?.[1];
  if (!received) return false;
  const left = Buffer.from(received, "utf8");
  const right = Buffer.from(secret, "utf8");
  if (left.length !== right.length) return false;
  return createHash("sha256").update(left).digest("hex") ===
    createHash("sha256").update(right).digest("hex");
}

function exactMatch(
  webhook: AirbnbLifecycleWebhookSnapshot,
  propertyId: string,
  callback: string,
  secret: string
): boolean {
  return (
    webhook.propertyId === propertyId &&
    webhook.callbackUrl === callback &&
    sameEventMask(webhook.eventMask) &&
    webhook.isActive &&
    webhook.sendData &&
    secretMatches(webhook.headers, secret)
  );
}

function paginationInteger(value: unknown, min: number, max: number): number | null {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= min &&
    value <= max
    ? value
    : null;
}

export function normalizeChannexLifecycleWebhookPayload(payload: unknown): unknown {
  const root = record(payload);
  if (!root || typeof root.event !== "string") return payload;
  if (root.event.trim().toLowerCase() !== "disconnected_channel") return payload;
  return { ...root, event: "disconnect_channel" };
}

export function createAirbnbLifecycleWebhookClient(args: {
  apiOrigin: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}) {
  const origin = exactOrigin(args.apiOrigin);
  const apiKey = String(args.apiKey ?? "").trim();
  if (!apiKey || apiKey.length > 4096) {
    throw new AirbnbLifecycleWebhookError(
      "AIRBNB_LIFECYCLE_WEBHOOK_API_KEY_INVALID"
    );
  }
  const fetchImpl = args.fetchImpl ?? fetch;

  const request = async (
    method: "GET" | "POST" | "PUT",
    path: string,
    body?: unknown
  ) => {
    const url = new URL(`/api/v1${path}`, origin);
    if (url.origin !== origin || !url.pathname.startsWith("/api/v1/")) {
      throw new AirbnbLifecycleWebhookError(
        "AIRBNB_LIFECYCLE_WEBHOOK_REQUEST_INVALID"
      );
    }
    const response = await fetchImpl(url, {
      method,
      redirect: "error",
      headers: {
        Accept: "application/json",
        "user-api-key": apiKey,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      throw new AirbnbLifecycleWebhookError(
        `AIRBNB_LIFECYCLE_WEBHOOK_PROVIDER_REQUEST_FAILED_${response.status}`
      );
    }
    return { status: response.status, payload };
  };

  return {
    async listAll(): Promise<AirbnbLifecycleWebhookSnapshot[]> {
      const resources: AirbnbLifecycleWebhookSnapshot[] = [];
      const ids = new Set<string>();
      let expectedTotal: number | null = null;

      for (let page = 1; page <= MAX_WEBHOOK_PAGES; page += 1) {
        const search = new URLSearchParams({
          "pagination[page]": String(page),
          "pagination[limit]": String(WEBHOOK_PAGE_LIMIT),
        });
        const response = await request("GET", `/webhooks?${search.toString()}`);
        if (!Array.isArray(response.payload?.data)) {
          throw new AirbnbLifecycleWebhookError(
            "AIRBNB_LIFECYCLE_WEBHOOK_LIST_INVALID"
          );
        }
        const meta = record(response.payload?.meta);
        const reportedPage = paginationInteger(meta?.page, 1, MAX_WEBHOOK_PAGES);
        const reportedLimit = paginationInteger(meta?.limit, 1, WEBHOOK_PAGE_LIMIT);
        const reportedTotal = paginationInteger(meta?.total, 0, MAX_WEBHOOK_RESOURCES);
        if (
          reportedPage !== page ||
          reportedLimit !== WEBHOOK_PAGE_LIMIT ||
          reportedTotal === null ||
          (expectedTotal !== null && expectedTotal !== reportedTotal)
        ) {
          throw new AirbnbLifecycleWebhookError(
            "AIRBNB_LIFECYCLE_WEBHOOK_PAGINATION_INVALID"
          );
        }
        expectedTotal = reportedTotal;

        if (response.payload.data.length > WEBHOOK_PAGE_LIMIT) {
          throw new AirbnbLifecycleWebhookError(
            "AIRBNB_LIFECYCLE_WEBHOOK_LIST_TOO_LARGE"
          );
        }
        for (const raw of response.payload.data) {
          const webhook = parseWebhook(raw);
          if (ids.has(webhook.id)) {
            throw new AirbnbLifecycleWebhookError(
              "AIRBNB_LIFECYCLE_WEBHOOK_DUPLICATE_RESOURCE"
            );
          }
          ids.add(webhook.id);
          resources.push(webhook);
          if (resources.length > MAX_WEBHOOK_RESOURCES) {
            throw new AirbnbLifecycleWebhookError(
              "AIRBNB_LIFECYCLE_WEBHOOK_LIST_TOO_LARGE"
            );
          }
        }

        if (resources.length === expectedTotal) return resources;
        if (
          resources.length > expectedTotal ||
          response.payload.data.length === 0 ||
          response.payload.data.length < WEBHOOK_PAGE_LIMIT
        ) {
          throw new AirbnbLifecycleWebhookError(
            "AIRBNB_LIFECYCLE_WEBHOOK_PAGINATION_INVALID"
          );
        }
      }

      throw new AirbnbLifecycleWebhookError(
        "AIRBNB_LIFECYCLE_WEBHOOK_LIST_TOO_LARGE"
      );
    },
    async get(webhookId: string): Promise<AirbnbLifecycleWebhookSnapshot> {
      const id = requiredUuid(
        webhookId,
        "AIRBNB_LIFECYCLE_WEBHOOK_ID_INVALID"
      );
      const response = await request(
        "GET",
        `/webhooks/${encodeURIComponent(id)}`
      );
      return parseWebhook(response.payload?.data);
    },
    async create(input: {
      propertyId: string;
      callbackUrl: string;
      secret: string;
    }): Promise<AirbnbLifecycleWebhookSnapshot> {
      const response = await request("POST", "/webhooks", {
        webhook: {
          property_id: input.propertyId,
          callback_url: input.callbackUrl,
          event_mask: AIRBNB_LIFECYCLE_WEBHOOK_EVENT_MASK,
          headers: {
            [AIRBNB_LIFECYCLE_WEBHOOK_SECRET_HEADER]: input.secret,
          },
          is_active: true,
          send_data: true,
        },
      });
      if (response.status !== 201) {
        throw new AirbnbLifecycleWebhookError(
          "AIRBNB_LIFECYCLE_WEBHOOK_CREATE_STATUS_INVALID"
        );
      }
      return parseWebhook(response.payload?.data);
    },
    async update(
      webhookId: string,
      input: { propertyId: string; callbackUrl: string; secret: string }
    ): Promise<AirbnbLifecycleWebhookSnapshot> {
      const id = requiredUuid(
        webhookId,
        "AIRBNB_LIFECYCLE_WEBHOOK_ID_INVALID"
      );
      const response = await request("PUT", `/webhooks/${encodeURIComponent(id)}`, {
        webhook: {
          property_id: input.propertyId,
          callback_url: input.callbackUrl,
          event_mask: AIRBNB_LIFECYCLE_WEBHOOK_EVENT_MASK,
          headers: {
            [AIRBNB_LIFECYCLE_WEBHOOK_SECRET_HEADER]: input.secret,
          },
          is_active: true,
          send_data: true,
        },
      });
      return parseWebhook(response.payload?.data);
    },
  };
}

export async function ensureAirbnbPropertyLifecycleWebhook(args: {
  apiOrigin: string;
  apiKey: string;
  externalPropertyId: string;
  callbackUrl: string;
  webhookSecret: string;
  fetchImpl?: typeof fetch;
}): Promise<AirbnbLifecycleWebhookEnsureResult> {
  const propertyId = requiredUuid(
    args.externalPropertyId,
    "AIRBNB_LIFECYCLE_WEBHOOK_PROPERTY_ID_INVALID"
  );
  const callback = callbackUrl(args.callbackUrl);
  const secret = requiredSecret(args.webhookSecret);
  const client = createAirbnbLifecycleWebhookClient({
    apiOrigin: args.apiOrigin,
    apiKey: args.apiKey,
    fetchImpl: args.fetchImpl,
  });
  const webhooks = await client.listAll();
  const candidates = webhooks.filter(
    (webhook) =>
      webhook.propertyId === propertyId && webhook.callbackUrl === callback
  );

  if (candidates.length > 1) {
    throw new AirbnbLifecycleWebhookError(
      "AIRBNB_LIFECYCLE_WEBHOOK_AMBIGUOUS"
    );
  }
  if (candidates.length === 0) {
    const created = await client.create({ propertyId, callbackUrl: callback, secret });
    const verified = await client.get(created.id);
    if (!exactMatch(verified, propertyId, callback, secret)) {
      throw new AirbnbLifecycleWebhookError(
        "AIRBNB_LIFECYCLE_WEBHOOK_CREATE_VERIFICATION_FAILED"
      );
    }
    return { status: "CREATED", webhookId: verified.id, providerMutations: 1 };
  }

  const candidate = candidates[0]!;
  if (exactMatch(candidate, propertyId, callback, secret)) {
    return { status: "UNCHANGED", webhookId: candidate.id, providerMutations: 0 };
  }
  if (!eventMaskWithinLifecycleScope(candidate.eventMask)) {
    throw new AirbnbLifecycleWebhookError(
      "AIRBNB_LIFECYCLE_WEBHOOK_SCOPE_CONFLICT"
    );
  }

  const updated = await client.update(candidate.id, {
    propertyId,
    callbackUrl: callback,
    secret,
  });
  const verified = await client.get(updated.id);
  if (!exactMatch(verified, propertyId, callback, secret)) {
    throw new AirbnbLifecycleWebhookError(
      "AIRBNB_LIFECYCLE_WEBHOOK_UPDATE_VERIFICATION_FAILED"
    );
  }
  return { status: "UPDATED", webhookId: verified.id, providerMutations: 1 };
}
