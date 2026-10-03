import { createHash } from "node:crypto";

export class InboxError extends Error {
  constructor(public code: string, public status = 502) { super(code); }
}
export type Scope = { organizationId: string; propertyId: string };
export type Page = { page: number; limit: number };
export type Message = { id: string; text: string; sender: "guest" | "property"; insertedAt: string; attachments: string[] };
export type Thread = {
  id: string; title: string; provider: string; isClosed: boolean; bookingId: string | null;
  messageCount: number; lastMessage: Omit<Message, "id"> | null; updatedAt: string;
};
export type Collection<T> = { items: T[]; page: number; limit: number; total: number };
export type InboxRequest = (input: { method: "GET" | "POST"; path: string; query?: Record<string, string>; body?: unknown }) => Promise<unknown>;
export type Receipt = { fingerprint: string; status: string; response: unknown };
export type InboxDependencies = {
  resolveProperty(scope: Scope): Promise<string>;
  request: InboxRequest;
  reserve(input: Scope & { threadId: string; requestedBy: string; requestKey: string; fingerprint: string }): Promise<{ fresh: boolean; receipt: Receipt }>;
  complete(organizationId: string, requestKey: string, response: Message): Promise<void>;
  unknown(organizationId: string, requestKey: string): Promise<void>;
};
type Obj = Record<string, unknown>;
function obj(value: unknown): Obj {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new InboxError("HOST_INBOX_RESPONSE_INVALID");
  return value as Obj;
}
function str(value: unknown): string {
  if (typeof value !== "string") throw new InboxError("HOST_INBOX_RESPONSE_INVALID");
  return value;
}
export function validId(value: string): boolean { return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value); }
function id(value: unknown): string {
  const result = str(value);
  if (!validId(result)) throw new InboxError("HOST_INBOX_RESPONSE_INVALID");
  return result;
}
function date(value: unknown): string {
  const result = str(value);
  if (!/^\d{4}-\d\d-\d\dT/.test(result) || !Number.isFinite(Date.parse(result))) throw new InboxError("HOST_INBOX_RESPONSE_INVALID");
  return /(?:Z|[+-]\d\d:\d\d)$/.test(result) ? result : `${result}Z`;
}
function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new InboxError("HOST_INBOX_RESPONSE_INVALID");
  return value;
}
function relation(resource: Obj, name: string, required = true): string | null {
  const rels = obj(resource.relationships);
  if ((!rels[name] || obj(rels[name]).data === null) && !required) return null;
  const data = obj(obj(rels[name]).data);
  if (data.type !== name) throw new InboxError("HOST_INBOX_RESPONSE_INVALID");
  return id(data.id);
}
function messageAttributes(value: unknown): Omit<Message, "id"> {
  const a = obj(value);
  if (a.sender !== "guest" && a.sender !== "property") throw new InboxError("HOST_INBOX_RESPONSE_INVALID");
  if (!Array.isArray(a.attachments) || a.attachments.some(x => typeof x !== "string")) throw new InboxError("HOST_INBOX_RESPONSE_INVALID");
  return { text: a.message == null ? "" : str(a.message), sender: a.sender,
    insertedAt: date(a.inserted_at), attachments: a.attachments as string[] };
}
function parseMessage(value: unknown, threadId: string): Message {
  const data = obj(value);
  if (data.type !== "message" || relation(data, "message_thread") !== threadId) throw new InboxError("HOST_INBOX_RESPONSE_INVALID");
  return { id: id(data.id), ...messageAttributes(data.attributes) };
}
function parseThread(value: unknown, propertyId: string): Thread {
  const data = obj(value), a = obj(data.attributes);
  if (data.type !== "message_thread" || relation(data, "property") !== propertyId) throw new InboxError("HOST_INBOX_THREAD_NOT_FOUND", 404);
  if (typeof a.is_closed !== "boolean") throw new InboxError("HOST_INBOX_RESPONSE_INVALID");
  return { id: id(data.id), title: str(a.title), provider: str(a.provider), isClosed: a.is_closed,
    bookingId: relation(data, "booking", false), messageCount: integer(a.message_count),
    lastMessage: a.last_message == null ? null : messageAttributes(a.last_message), updatedAt: date(a.updated_at) };
}
function collection<T extends { id: string }>(value: unknown, page: Page, parse: (item: unknown) => T): Collection<T> {
  const root = obj(value), meta = obj(root.meta);
  if (!Array.isArray(root.data) || integer(meta.page) !== page.page || integer(meta.limit) !== page.limit || root.data.length > page.limit) throw new InboxError("HOST_INBOX_RESPONSE_INVALID");
  const total = integer(meta.total), items = root.data.map(parse);
  if (new Set(items.map(x => x.id)).size !== items.length || items.length > total ||
    items.length !== Math.min(page.limit, Math.max(0, total - (page.page - 1) * page.limit))) throw new InboxError("HOST_INBOX_RESPONSE_INVALID");
  return { items, ...page, total };
}
function pagination(page: Page) {
  if (!Number.isSafeInteger(page.page) || page.page < 1 || page.page > 10000 || !Number.isSafeInteger(page.limit) || page.limit < 1 || page.limit > 100) throw new InboxError("HOST_INBOX_PAGE_INVALID", 400);
  return { "pagination[page]": String(page.page), "pagination[limit]": String(page.limit), "order[inserted_at]": "desc" };
}
export function createHostInbox(deps: InboxDependencies) {
  async function thread(scope: Scope, threadId: string) {
    if (!validId(threadId)) throw new InboxError("HOST_INBOX_THREAD_INVALID", 400);
    const remote = await deps.resolveProperty(scope);
    const data = obj(await deps.request({ method: "GET", path: `/api/v1/message_threads/${threadId}` })).data;
    const result = parseThread(data, remote);
    if (result.id !== threadId) throw new InboxError("HOST_INBOX_RESPONSE_INVALID");
    return result;
  }
  return {
    async list(scope: Scope, page: Page) {
      const query = pagination(page), remote = await deps.resolveProperty(scope);
      return collection(await deps.request({ method: "GET", path: "/api/v1/message_threads", query: { ...query, "filter[property_id]": remote } }), page, x => parseThread(x, remote));
    },
    async messages(scope: Scope, threadId: string, page: Page) {
      const query = pagination(page), detail = await thread(scope, threadId);
      const messages = collection(await deps.request({ method: "GET", path: `/api/v1/message_threads/${threadId}/messages`, query }), page, x => parseMessage(x, threadId));
      return { thread: detail, ...messages };
    },
    async reply(input: Scope & { threadId: string; text: string; requestedBy: string; requestKey: string }) {
      if (!input.text.trim() || input.text.length > 5000 || !/^[A-Za-z0-9._:-]{8,120}$/.test(input.requestKey)) throw new InboxError("HOST_INBOX_REPLY_INVALID", 400);
      const detail = await thread(input, input.threadId);
      if (detail.isClosed) throw new InboxError("HOST_INBOX_THREAD_CLOSED", 409);
      if (!["bookingcom", "airbnb", "expedia"].includes(detail.provider.toLowerCase())) throw new InboxError("HOST_INBOX_PROVIDER_UNSUPPORTED", 422);
      const fingerprint = createHash("sha256").update(JSON.stringify([input.propertyId, input.threadId, input.text, input.requestedBy])).digest("hex");
      const reserved = await deps.reserve({ ...input, fingerprint });
      if (!reserved.fresh) {
        if (reserved.receipt.fingerprint !== fingerprint) throw new InboxError("HOST_INBOX_REQUEST_KEY_CONFLICT", 409);
        if (reserved.receipt.status !== "SENT") throw new InboxError("HOST_INBOX_SEND_OUTCOME_UNKNOWN", 409);
        return { message: reserved.receipt.response as Message, replayed: true };
      }
      try {
        const response = await deps.request({ method: "POST", path: `/api/v1/message_threads/${input.threadId}/messages`, body: { message: { message: input.text } } });
        const message = parseMessage(obj(response).data, input.threadId);
        if (message.sender !== "property") throw new InboxError("HOST_INBOX_RESPONSE_INVALID");
        await deps.complete(input.organizationId, input.requestKey, message);
        return { message, replayed: false };
      } catch {
        // Even HTTP errors can follow acceptance. Preserve the key across restarts.
        await deps.unknown(input.organizationId, input.requestKey).catch(() => {});
        throw new InboxError("HOST_INBOX_SEND_OUTCOME_UNKNOWN", 409);
      }
    },
  };
}

export function createInboxHttpRequest(args: { apiOrigin: string; apiKey: string; fetchImpl?: typeof fetch }): InboxRequest {
  if (!["https://app.channex.io", "https://staging.channex.io"].includes(args.apiOrigin) || !args.apiKey.trim()) throw new InboxError("HOST_INBOX_CONFIGURATION_INVALID", 503);
  return async input => {
    if (!/^\/api\/v1\/message_threads(?:\/[0-9a-f-]{36}(?:\/messages)?)?$/i.test(input.path) ||
      (input.method === "POST" && !input.path.endsWith("/messages"))) throw new InboxError("HOST_INBOX_REQUEST_INVALID");
    const url = new URL(input.path, args.apiOrigin);
    for (const [key, value] of Object.entries(input.query ?? {})) url.searchParams.set(key, value);
    try {
      const res = await (args.fetchImpl ?? fetch)(url, { method: input.method, redirect: "error",
        headers: { "user-api-key": args.apiKey, Accept: "application/json", "Content-Type": "application/json" },
        ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}), signal: AbortSignal.timeout(15000) });
      if (!res.ok) {
        await res.body?.cancel();
        throw new InboxError(res.status === 403 ? "HOST_INBOX_APPLICATION_UNAVAILABLE" : res.status === 404 ? "HOST_INBOX_THREAD_NOT_FOUND" : res.status === 429 ? "HOST_INBOX_RATE_LIMITED" : "HOST_INBOX_PROVIDER_UNAVAILABLE", res.status === 404 ? 404 : res.status === 429 ? 429 : 503);
      }
      const reader = res.body?.getReader();
      if (!reader) throw new InboxError("HOST_INBOX_RESPONSE_INVALID");
      const chunks: Uint8Array[] = []; let size = 0;
      try {
        while (true) {
          const part = await reader.read(); if (part.done) break;
          size += part.value.byteLength;
          if (size > 1_000_000) throw new InboxError("HOST_INBOX_RESPONSE_LIMIT");
          chunks.push(part.value);
        }
      } finally { await reader.cancel(); }
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    } catch (error) {
      if (error instanceof InboxError) throw error;
      throw new InboxError("HOST_INBOX_PROVIDER_UNAVAILABLE", 503);
    }
  };
}
