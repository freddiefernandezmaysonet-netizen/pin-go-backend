import type {
  ChannexChannelLifecycleProductionRegistrationTransport,
  ChannexWebhookSnapshot,
} from "./channex-channel-lifecycle-webhook-registration.js";
import type { ChannexChannelLifecycleWebhookWritePayload } from "./channex-channel-lifecycle-webhook.contract.js";

const PRODUCTION_ORIGIN = "https://app.channex.io";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PAGE_LIMIT = 100;
const MAX_PAGES = 50;

function record(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, any>
    : {};
}

function snapshot(value: unknown): ChannexWebhookSnapshot {
  const resource = record(value);
  const attributes = record(resource.attributes);
  const relationships = record(record(resource.relationships).property);
  const property = record(relationships.data);
  const headers = record(attributes.headers);
  return {
    id: String(resource.id ?? "").trim(),
    propertyId: String(attributes.property_id ?? property.id ?? "").trim() || null,
    callbackUrl: String(attributes.callback_url ?? "").trim(),
    eventMask: String(attributes.event_mask ?? "").trim(),
    headers: Object.keys(headers).length
      ? Object.fromEntries(Object.entries(headers).map(([key, value]) => [key, String(value)]))
      : null,
    isActive: attributes.is_active === true,
    sendData: attributes.send_data === true,
    isGlobal: attributes.is_global === true,
    isProtected: attributes.protected === true,
  };
}

function resources(payload: unknown): unknown[] {
  const data = record(payload).data;
  return Array.isArray(data) ? data : [];
}

function resource(payload: unknown): unknown {
  return record(payload).data;
}

export function createChannexChannelLifecycleWebhookRegistrationHttpTransport(args: {
  apiOrigin: string;
  apiKey: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}): ChannexChannelLifecycleProductionRegistrationTransport {
  if (args.apiOrigin !== PRODUCTION_ORIGIN) {
    throw new Error("OTA_CHANNEL_LIFECYCLE_WEBHOOK_PRODUCTION_ORIGIN_REQUIRED");
  }
  const apiKey = String(args.apiKey ?? "").trim();
  if (!apiKey) throw new Error("OTA_CONNECTION_API_KEY_REQUIRED");
  const fetchImpl = args.fetchImpl ?? fetch;
  async function request(path: string, init: RequestInit): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), args.timeoutMs);
    try {
      const response = await fetchImpl(`${PRODUCTION_ORIGIN}${path}`, {
        ...init,
        redirect: "error",
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "user-api-key": apiKey,
          ...init.headers,
        },
      });
      if (!response.ok) throw new Error(`OTA_CHANNEL_LIFECYCLE_WEBHOOK_HTTP_${response.status}`);
      return await response.json();
    } finally {
      clearTimeout(timeout);
    }
  }
  return {
    apiOrigin: PRODUCTION_ORIGIN,
    async listAllWebhooks() {
      const all: ChannexWebhookSnapshot[] = [];
      const ids = new Set<string>();
      let expectedTotal: number | null = null;
      for (let page = 1; page <= MAX_PAGES; page += 1) {
        const payload = await request(
          `/api/v1/webhooks?pagination%5Bpage%5D=${page}&pagination%5Blimit%5D=${PAGE_LIMIT}`,
          { method: "GET" }
        );
        const root = record(payload);
        const meta = record(root.meta);
        const reportedPage = Number(meta.page);
        const reportedLimit = Number(meta.limit);
        const reportedTotal = Number(meta.total);
        if (
          !Number.isInteger(reportedPage) || reportedPage !== page ||
          !Number.isInteger(reportedLimit) || reportedLimit !== PAGE_LIMIT ||
          !Number.isInteger(reportedTotal) || reportedTotal < 0 ||
          (expectedTotal !== null && expectedTotal !== reportedTotal)
        ) {
          throw new Error("OTA_CHANNEL_LIFECYCLE_WEBHOOK_LIST_RESPONSE_INVALID");
        }
        expectedTotal ??= reportedTotal;
        for (const item of resources(payload).map(snapshot)) {
          if (!UUID.test(item.id) || ids.has(item.id)) {
            throw new Error("OTA_CHANNEL_LIFECYCLE_WEBHOOK_LIST_RESPONSE_INVALID");
          }
          ids.add(item.id);
          all.push(item);
        }
        if (all.length === expectedTotal) return all;
        if (all.length > expectedTotal || resources(payload).length !== PAGE_LIMIT) {
          throw new Error("OTA_CHANNEL_LIFECYCLE_WEBHOOK_LIST_RESPONSE_INVALID");
        }
      }
      throw new Error("OTA_CHANNEL_LIFECYCLE_WEBHOOK_LIST_RESPONSE_TOO_LARGE");
    },
    async postWebhook(payload) {
      const id = String(record(resource(await request("/api/v1/webhooks", {
        method: "POST", body: JSON.stringify(payload),
      }))).id ?? "").trim();
      if (!UUID.test(id)) throw new Error("OTA_CHANNEL_LIFECYCLE_WEBHOOK_CREATE_RESPONSE_INVALID");
      return id.toLowerCase();
    },
    async putWebhook(webhookId, payload) {
      await request(`/api/v1/webhooks/${encodeURIComponent(webhookId)}`, {
        method: "PUT", body: JSON.stringify(payload),
      });
    },
    async getWebhook(webhookId) {
      return snapshot(resource(await request(
        `/api/v1/webhooks/${encodeURIComponent(webhookId)}`,
        { method: "GET" }
      )));
    },
  };
}
