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
  "disconnect_channel",
  "disconnect_listing",
] as const;
export const AIRBNB_LIFECYCLE_WEBHOOK_EVENT_MASK =
  AIRBNB_LIFECYCLE_WEBHOOK_EVENTS.join(";");

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ALLOWED_ORIGIN = "https://app.channex.io";

export class AirbnbLifecycleWebhookError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "AirbnbLifecycleWebhookError";
  }
}

export type AirbnbLifecycleWebhookSnapshot = {
  id: string;
  propertyId: string | null;
  callbackUrl: string;
  eventMask: string;
  headers: Readonly<Record<string, string>>;
  isActive: boolean;
  sendData: boolean;
  isGlobal: boolean;
};

export type AirbnbLifecycleWebhookEnsureResult = {
  status: "CREATED" | "UPDATED" | "UNCHANGED";
  webhookId: string;
  providerMutations: 0 | 1;
};

function exactOrigin(value: unknown): string {
  try {
    const url = new URL(String(value ?? "").trim());
    if (url.origin !== ALLOWED_ORIGIN || url.href.replace(/\/$/, "") !== url.origin) {
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

  const rawPropertyId = attributes?.property_id ?? propertyRel?.id ?? null;
  const propertyId = rawPropertyId === null
    ? null
    : requiredUuid(
        rawPropertyId,
        "AIRBNB_LIFECYCLE_WEBHOOK_RESPONSE_PROPERTY_INVALID"
      );
  const isGlobal = attributes?.is_global === true;

  return {
    id,
    propertyId,
    callbackUrl: String(attributes.callback_url).trim(),
    eventMask: String(attributes.event_mask).trim().toLowerCase(),
    headers: stringRecord(attributes.headers),
    isActive: attributes.is_active,
    sendData: attributes.send_data,
    isGlobal,
  };
}

function eventMaskParts(value: string): string[] | null {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw || raw === "*") return null;
  const parts = raw.split(";").map((item) => item.trim());
  if (parts.some((item) => !item) || new Set(parts).size !== parts.length) {
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

function exactGlobalMatch(
  webhook: AirbnbLifecycleWebhookSnapshot,
  callback: string,
  secret: string
): boolean {
  return (
    webhook.propertyId === null &&
    webhook.isGlobal === true &&
    webhook.callbackUrl === callback &&
    sameEventMask(webhook.eventMask) &&
    webhook.isActive &&
    webhook.sendData &&
    secretMatches(webhook.headers, secret)
  );
}

export function normalizeChannexLifecycleWebhookPayload(payload: unknown): unknown {
  const root = record(payload);
  if (!root || typeof root.event !== "string") return payload;
  // Backward-compatible normalization for any historic payload spelling.
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
      // Production Channex currently accepts the plain endpoint and rejects the
      // pagination query previously used here. Because Pin&Go owns one global
      // lifecycle webhook, ambiguity is handled fail-closed below.
      const response = await request("GET", "/webhooks");
      if (!Array.isArray(response.payload?.data)) {
        throw new AirbnbLifecycleWebhookError(
          "AIRBNB_LIFECYCLE_WEBHOOK_LIST_INVALID"
        );
      }
      return response.payload.data.map(parseWebhook);
    },
    async get(webhookId: string): Promise<AirbnbLifecycleWebhookSnapshot> {
      const id = requiredUuid(
        webhookId,
        "AIRBNB_LIFECYCLE_WEBHOOK_ID_INVALID"
      );
      const response = await request("GET", `/webhooks/${encodeURIComponent(id)}`);
      return parseWebhook(response.payload?.data);
    },
    async createGlobal(input: {
      callbackUrl: string;
      secret: string;
    }): Promise<AirbnbLifecycleWebhookSnapshot> {
      const response = await request("POST", "/webhooks", {
        webhook: {
          property_id: null,
          is_global: true,
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
    async updateGlobal(
      webhookId: string,
      input: { callbackUrl: string; secret: string }
    ): Promise<AirbnbLifecycleWebhookSnapshot> {
      const id = requiredUuid(webhookId, "AIRBNB_LIFECYCLE_WEBHOOK_ID_INVALID");
      const response = await request("PUT", `/webhooks/${encodeURIComponent(id)}`, {
        webhook: {
          property_id: null,
          is_global: true,
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

export async function ensureAirbnbGlobalLifecycleWebhook(args: {
  apiOrigin: string;
  apiKey: string;
  callbackUrl: string;
  webhookSecret: string;
  fetchImpl?: typeof fetch;
}): Promise<AirbnbLifecycleWebhookEnsureResult> {
  const callback = callbackUrl(args.callbackUrl);
  const secret = requiredSecret(args.webhookSecret);
  const client = createAirbnbLifecycleWebhookClient({
    apiOrigin: args.apiOrigin,
    apiKey: args.apiKey,
    fetchImpl: args.fetchImpl,
  });
  const webhooks = await client.listAll();
  const candidates = webhooks.filter(
    (webhook) => webhook.isGlobal && webhook.callbackUrl === callback
  );

  if (candidates.length > 1) {
    throw new AirbnbLifecycleWebhookError("AIRBNB_LIFECYCLE_WEBHOOK_AMBIGUOUS");
  }
  if (candidates.length === 0) {
    const created = await client.createGlobal({ callbackUrl: callback, secret });
    const verified = await client.get(created.id);
    if (!exactGlobalMatch(verified, callback, secret)) {
      throw new AirbnbLifecycleWebhookError(
        "AIRBNB_LIFECYCLE_WEBHOOK_CREATE_VERIFICATION_FAILED"
      );
    }
    return { status: "CREATED", webhookId: verified.id, providerMutations: 1 };
  }

  const candidate = candidates[0]!;
  if (exactGlobalMatch(candidate, callback, secret)) {
    return { status: "UNCHANGED", webhookId: candidate.id, providerMutations: 0 };
  }
  if (!eventMaskWithinLifecycleScope(candidate.eventMask)) {
    throw new AirbnbLifecycleWebhookError(
      "AIRBNB_LIFECYCLE_WEBHOOK_SCOPE_CONFLICT"
    );
  }

  const updated = await client.updateGlobal(candidate.id, {
    callbackUrl: callback,
    secret,
  });
  const verified = await client.get(updated.id);
  if (!exactGlobalMatch(verified, callback, secret)) {
    throw new AirbnbLifecycleWebhookError(
      "AIRBNB_LIFECYCLE_WEBHOOK_UPDATE_VERIFICATION_FAILED"
    );
  }
  return { status: "UPDATED", webhookId: verified.id, providerMutations: 1 };
}

// Compatibility shim for code/tests introduced by #116. The external property
// identity is deliberately ignored because the production contract is global.
export async function ensureAirbnbPropertyLifecycleWebhook(args: {
  apiOrigin: string;
  apiKey: string;
  externalPropertyId: string;
  callbackUrl: string;
  webhookSecret: string;
  fetchImpl?: typeof fetch;
}): Promise<AirbnbLifecycleWebhookEnsureResult> {
  return ensureAirbnbGlobalLifecycleWebhook({
    apiOrigin: args.apiOrigin,
    apiKey: args.apiKey,
    callbackUrl: args.callbackUrl,
    webhookSecret: args.webhookSecret,
    fetchImpl: args.fetchImpl,
  });
}
