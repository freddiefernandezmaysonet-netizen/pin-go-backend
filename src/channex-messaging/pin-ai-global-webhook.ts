import { AI_WEBHOOK_HEADER, validWebhookSecret } from "./pin-ai-auto.policy.js";

type Request = (method: "GET" | "POST", page?: number, body?: unknown) => Promise<any>;
// Deployment-only registration. Never used by the API or the message worker.
// The caller supplies a durable claim before POST; an uncertain attempt may
// only reconcile by GET on subsequent executions.
export async function ensureGlobalMessageWebhook(input: { callbackUrl: string; secret: string;
  request: Request; claim(): Promise<boolean>; verified(id: string): Promise<void> }) {
  const callback = new URL(input.callbackUrl);
  if (callback.protocol !== "https:" || callback.username || callback.password || callback.search || callback.hash ||
      callback.pathname !== "/webhooks/ota/channex/messages" || !validWebhookSecret(input.secret, input.secret))
    throw Error("PIN_AI_GLOBAL_WEBHOOK_CONFIGURATION_INVALID");
  async function find() {
    const matches: any[] = [], ids = new Set<string>(); let count = 0;
    for (let page = 1; page <= 5; page++) {
      const result = await input.request("GET", page);
      if (!Array.isArray(result.data) || !result.meta || result.meta.page !== page ||
          result.meta.limit !== 100 || !Number.isSafeInteger(result.meta.total) || result.meta.total < 0)
        throw Error("PIN_AI_GLOBAL_WEBHOOK_RESPONSE_INVALID");
      for (const row of result.data) {
        if (!row.id || ids.has(row.id) || !row.attributes) throw Error("PIN_AI_GLOBAL_WEBHOOK_RESPONSE_INVALID");
        ids.add(row.id); count++;
        if (row.attributes.callback_url === callback.href && row.attributes.is_global === true) matches.push(row);
      }
      if (count >= result.meta.total) {
        if (count !== result.meta.total || matches.length > 1) throw Error("PIN_AI_GLOBAL_WEBHOOK_RESPONSE_INVALID");
        const row = matches[0]; if (!row) return null;
        const a = row.attributes;
        if (a.event_mask !== "message" || a.is_active !== true || a.send_data !== true ||
            a.headers?.[AI_WEBHOOK_HEADER] !== input.secret || row.relationships?.property?.data)
          throw Error("PIN_AI_GLOBAL_WEBHOOK_CONFLICT");
        return String(row.id);
      }
      if (result.data.length !== 100) throw Error("PIN_AI_GLOBAL_WEBHOOK_RESPONSE_INVALID");
    }
    throw Error("PIN_AI_GLOBAL_WEBHOOK_PAGINATION_LIMIT");
  }
  const existing = await find();
  if (existing) { await input.verified(existing); return { id: existing, created: false }; }
  if (!await input.claim()) throw Error("PIN_AI_GLOBAL_WEBHOOK_RECONCILIATION_REQUIRED");
  await input.request("POST", undefined, { webhook: { callback_url: callback.href, property_id: null,
    is_global: true, event_mask: "message", headers: { [AI_WEBHOOK_HEADER]: input.secret },
    request_params: {}, is_active: true, send_data: true } });
  const id = await find();
  if (!id) throw Error("PIN_AI_GLOBAL_WEBHOOK_NOT_VERIFIED");
  await input.verified(id);
  return { id, created: true };
}
