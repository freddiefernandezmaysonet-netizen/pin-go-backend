import { createHash } from "node:crypto";
import { InboxError, type Scope, type Message, type Thread, type Page, type Collection } from "./host-inbox.js";

export type DraftInput = Scope & { threadId: string; messageId: string };
export type DraftHistory = Collection<Message> & { thread: Thread };
export type DraftContext = Scope & { reservationId: string | null; bookingId?: string; preferredLanguage: "en" | "es"; timezone: string | null };
export type DraftResult = { text: string; requiresHumanReview: boolean; basedOnMessageId: string; sent: false };

function snapshot(history: DraftHistory, messageId: string) {
  if (history.thread.isClosed) throw new InboxError("HOST_INBOX_THREAD_CLOSED", 409);
  if (!["airbnb", "bookingcom", "expedia"].includes(history.thread.provider.toLowerCase())) throw new InboxError("HOST_INBOX_PROVIDER_UNSUPPORTED", 422);
  const ordered = [...history.items].sort((a, b) => Date.parse(a.insertedAt) - Date.parse(b.insertedAt) || a.id.localeCompare(b.id));
  const latest = ordered.at(-1);
  // The caller must be looking at the latest unanswered guest message. Never silently answer a different question.
  if (!latest || latest.id !== messageId || latest.sender !== "guest" || !latest.text.trim()) throw new InboxError("PIN_AI_DRAFT_NO_PENDING_MESSAGE", 409);
  const last = history.thread.lastMessage;
  if ((last && (last.sender !== latest.sender || last.text !== latest.text || last.insertedAt !== latest.insertedAt)) ||
    ordered.some(m => m.sender === "property" && Date.parse(m.insertedAt) >= Date.parse(latest.insertedAt))) throw new InboxError("PIN_AI_DRAFT_CONVERSATION_CHANGED", 409);
  if (ordered.some(m => m.attachments.length > 0)) throw new InboxError("PIN_AI_DRAFT_ATTACHMENT_REVIEW", 422);
  if (ordered.reduce((size, m) => size + m.text.length, 0) > 24000) throw new InboxError("PIN_AI_DRAFT_CONTEXT_TOO_LARGE", 422);
  return { ordered, fingerprint: createHash("sha256").update(JSON.stringify([history.thread, ordered])).digest("hex") };
}

export function createPinAIInboxDrafts(deps: {
  enabled(scope: Scope): boolean | Promise<boolean>;
  messages(scope: Scope, threadId: string, page: Page): Promise<DraftHistory>;
  resolveContext(scope: Scope, thread: Thread): Promise<DraftContext>;
  run(context: DraftContext, messages: Message[], threadId: string): Promise<{ text: string; requiresHumanReview: boolean }>;
}) {
  // Bounded per-process concurrency guard; drafts never acquire a send receipt or invoke delivery.
  const active = new Set<string>();
  return async (input: DraftInput): Promise<DraftResult> => {
    if (!await deps.enabled(input)) throw new InboxError("PIN_AI_DRAFT_DISABLED", 503);
    const key = JSON.stringify([input.organizationId, input.propertyId, input.threadId]);
    if (active.has(key) || active.size >= 8) throw new InboxError("PIN_AI_DRAFT_BUSY", 429);
    active.add(key);
    try {
      const history = await deps.messages(input, input.threadId, { page: 1, limit: 25 });
      const before = snapshot(history, input.messageId);
      const context = await deps.resolveContext(input, history.thread);
      if (context.organizationId !== input.organizationId || context.propertyId !== input.propertyId) throw new InboxError("PIN_AI_DRAFT_SCOPE_INVALID", 403);
      const result = await deps.run(context, before.ordered, input.threadId);
      if (!result.text.trim() || result.text.length > 5000) throw new InboxError("PIN_AI_DRAFT_RESPONSE_INVALID", 503);
      const after = snapshot(await deps.messages(input, input.threadId, { page: 1, limit: 25 }), input.messageId);
      if (before.fingerprint !== after.fingerprint) throw new InboxError("PIN_AI_DRAFT_CONVERSATION_CHANGED", 409);
      return { text: result.text.trim(), requiresHumanReview: result.requiresHumanReview, basedOnMessageId: input.messageId, sent: false };
    } finally { active.delete(key); }
  };
}
