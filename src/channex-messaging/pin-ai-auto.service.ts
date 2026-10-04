import { createHash } from "node:crypto";
import { InboxError, type Message } from "./host-inbox.js";
import type { DraftHistory, DraftInput, DraftResult } from "./pin-ai-draft.js";
import type { AIJob, AutoRepository } from "./pin-ai-auto.repository.js";

export function createAutomaticResponder(deps: {
  repository: Pick<AutoRepository, "state" | "ownMessageIds" | "fence" | "finish">;
  enabled(job: AIJob): boolean;
  messages(job: AIJob): Promise<DraftHistory>;
  generate(input: DraftInput): Promise<DraftResult>;
  send(input: DraftInput & { text: string; requestedBy: string; requestKey: string }): Promise<unknown>;
}) {
  async function check(job: AIJob, history: DraftHistory) {
    if (!deps.enabled(job)) return "DISABLED";
    const state = await deps.repository.state(job);
    if (state?.mode !== "AUTO" || state.leaseToken !== job.leaseToken) return "HOST_TAKEOVER";
    if (history.thread.isClosed) return "THREAD_CLOSED";
    const sorted = [...history.items].sort((a, b) => Date.parse(a.insertedAt) - Date.parse(b.insertedAt) || a.id.localeCompare(b.id));
    // Do not infer host absence when the recent window cannot cover the activation/resume boundary.
    if (history.total > sorted.length && Date.parse(sorted[0]?.insertedAt ?? "") >= job.since.getTime()) return "HISTORY_REQUIRES_REVIEW";
    const propertyMessages = sorted.filter(m => m.sender === "property" && Date.parse(m.insertedAt) >= job.since.getTime());
    const own = await deps.repository.ownMessageIds(job, propertyMessages.map(m => m.id));
    if (propertyMessages.some(m => !own.has(m.id))) return "HOST_TAKEOVER";
    const latest = sorted.at(-1);
    if (!latest || latest.id !== job.messageId || latest.sender !== "guest") return "SUPERSEDED_OR_ECHO";
    if (Date.parse(latest.insertedAt) <= job.since.getTime()) return "BEFORE_ACTIVATION";
    if (Date.parse(latest.insertedAt) > Date.now() + 60000) return "INVALID_MESSAGE_TIME";
    return null;
  }
  const fingerprint = (history: DraftHistory) => createHash("sha256").update(JSON.stringify([history.thread, history.items.map((m: Message) => [m.id, m.text, m.sender, m.insertedAt, m.attachments])])).digest("hex");
  const skip = new Set(["DISABLED", "THREAD_CLOSED", "SUPERSEDED_OR_ECHO", "BEFORE_ACTIVATION"]);
  return async (job: AIJob) => {
    let fenced = false;
    const finish = async (reason: string) => deps.repository.finish(job, skip.has(reason) ? "SKIPPED" : "NEEDS_HOST", reason);
    try {
      // A crashed/expired dispatch can have reached the provider. Never generate or send again.
      if (job.status === "SENDING") { await deps.repository.finish(job, "UNKNOWN", "DELIVERY_RECONCILIATION_REQUIRED"); return; }
      const before = await deps.messages(job), reason = await check(job, before);
      if (reason) { await finish(reason); return; }
      const response = await deps.generate(job);
      // Match Manage Reservation: review metadata does not suppress the guest-facing
      // runtime response or transfer ownership of the whole conversation to the host.
      const after = await deps.messages(job), changed = await check(job, after);
      if (changed) { await finish(changed); return; }
      if (fingerprint(before) !== fingerprint(after) || response.basedOnMessageId !== job.messageId) { await finish("CONVERSATION_CHANGED"); return; }
      if (!await deps.repository.fence(job)) { await finish("HOST_TAKEOVER"); return; }
      fenced = true;
      await deps.send({ ...job, text: response.text, requestedBy: "pin-ai-channex",
        requestKey: `pin-ai:${createHash("sha256").update(JSON.stringify([job.organizationId, job.propertyId, job.threadId, job.messageId])).digest("hex")}` });
      await deps.repository.finish(job, "SENT", response.requiresHumanReview ? "CHANNEX_ACCEPTED_REVIEW_REQUESTED" : "CHANNEX_ACCEPTED");
    } catch (error) {
      // Only sanitized finite error codes are stored. Raw model/provider text is never logged here.
      const reason = error instanceof InboxError && /^[A-Z0-9_]{1,100}$/.test(error.code) ? error.code : "PIN_AI_PROCESSING_FAILED";
      await deps.repository.finish(job, fenced ? "UNKNOWN" : "NEEDS_HOST", reason);
    }
  };
}
