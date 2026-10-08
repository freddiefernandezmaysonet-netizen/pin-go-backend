import { randomUUID } from "node:crypto";
import type { PrismaClient, ChannexAIInbound } from "@prisma/client";
import { InboxError, type Scope } from "./host-inbox.js";

export type AIThreadScope = Scope & { threadId: string };
export type AIJob = ChannexAIInbound & { since: Date };
export type AIOutcome = "SENT" | "SKIPPED" | "NEEDS_HOST" | "UNKNOWN";
const threadKey = (s: AIThreadScope) => ({ organizationId: s.organizationId, propertyId: s.propertyId, threadId: s.threadId });
export function createAutoRepository(db: PrismaClient) {
  return {
    async enqueue(input: AIThreadScope & { messageId: string }) {
      const key = { ...threadKey(input), messageId: input.messageId };
      await db.channexAIInbound.createMany({ data: [key], skipDuplicates: true });
    },
    async state(scope: AIThreadScope) {
      return db.channexAIThread.findUnique({ where: { organizationId_propertyId_threadId: threadKey(scope) } });
    },
    async control(scope: AIThreadScope, mode: "AUTO" | "HUMAN", since: Date) {
      return db.$transaction(async tx => {
        const key = threadKey(scope);
        await tx.channexAIThread.createMany({ data: [{ ...key, mode: "HUMAN", since, reason: "HOST_TAKEOVER" }], skipDuplicates: true });
        const row = await tx.channexAIThread.findUniqueOrThrow({ where: { organizationId_propertyId_threadId: key } });
        if (mode === "AUTO") {
          const changed = await tx.channexAIThread.updateMany({ where: { id: row.id, sending: false,
            OR: [{ leaseUntil: null }, { leaseUntil: { lt: new Date() } }] }, data: { mode, since, reason: null } });
          if (!changed.count) throw new InboxError("PIN_AI_CONVERSATION_BUSY", 409);
          return { mode, reason: null, sending: false };
        }
        const paused = await tx.channexAIThread.update({ where: { id: row.id }, data: { mode, reason: "HOST_TAKEOVER" } });
        return { mode, reason: paused.reason, sending: paused.sending };
      });
    },
    async candidates() {
      return db.channexAIInbound.findMany({ where: { OR: [{ status: "QUEUED" },
        { status: { in: ["PROCESSING", "SENDING"] }, leaseUntil: { lt: new Date() } }] }, orderBy: { receivedAt: "asc" }, take: 20 });
    },
    async claim(candidate: ChannexAIInbound, since: Date): Promise<AIJob | null> {
      return db.$transaction(async tx => {
        const key = threadKey(candidate), now = new Date(), token = randomUUID(), until = new Date(now.getTime() + 180000);
        await tx.channexAIThread.createMany({ data: [{ ...key, since }], skipDuplicates: true });
        // Row update serializes claimants across processes, without holding a transaction during network calls.
        const acquired = await tx.channexAIThread.updateMany({ where: { ...key,
          OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] }, data: { leaseToken: token, leaseUntil: until } });
        if (!acquired.count) return null;
        const row = await tx.channexAIThread.findUniqueOrThrow({ where: { organizationId_propertyId_threadId: key } });
        const changed = await tx.channexAIInbound.updateMany({ where: { id: candidate.id, status: candidate.status, OR: [{ status: "QUEUED" },
          { status: { in: ["PROCESSING", "SENDING"] }, leaseUntil: { lt: now } }] },
          data: { status: candidate.status === "SENDING" ? "SENDING" : "PROCESSING", leaseToken: token, leaseUntil: until } });
        if (!changed.count) {
          await tx.channexAIThread.updateMany({ where: { ...key, leaseToken: token }, data: { leaseToken: null, leaseUntil: null } });
          return null;
        }
        return { ...candidate, leaseToken: token, leaseUntil: until, since: new Date(Math.max(since.getTime(), row.since.getTime())) };
      });
    },
    async fence(job: AIJob) {
      return db.$transaction(async tx => {
        const changed = await tx.channexAIThread.updateMany({ where: { ...threadKey(job), mode: "AUTO", leaseToken: job.leaseToken,
          leaseUntil: { gt: new Date() }, sending: false }, data: { sending: true } });
        if (!changed.count) return false;
        const receipt = await tx.channexAIInbound.updateMany({ where: { id: job.id, leaseToken: job.leaseToken, status: "PROCESSING" }, data: { status: "SENDING" } });
        if (!receipt.count) throw new Error("PIN_AI_SEND_FENCE_CONFLICT");
        return true;
      });
    },
    async finish(job: AIJob, status: AIOutcome, reason: string) {
      await db.$transaction(async tx => {
        const changed = await tx.channexAIInbound.updateMany({ where: { id: job.id, leaseToken: job.leaseToken,
          status: { in: ["PROCESSING", "SENDING"] } }, data: { status, reason, leaseToken: null, leaseUntil: null } });
        if (!changed.count) return;
        await tx.channexAIThread.updateMany({ where: { ...threadKey(job), leaseToken: job.leaseToken }, data: {
          leaseToken: null, leaseUntil: null, sending: false,
          ...(["NEEDS_HOST", "UNKNOWN"].includes(status) ? { mode: "HUMAN", reason } : {}),
        } });
      });
    },
    async ownMessageIds(scope: AIThreadScope, ids: string[]) {
      // Only property messages visible within the bounded 25-message window
      // matter for takeover detection. Operational pre-checkin/access/checkout
      // messages are Pin&Go-owned, not a human host intervention.
      if (!ids.length) return new Set<string>();
      const [receipts, operational] = await Promise.all([
        db.channexHostMessageSend.findMany({ where: {
          ...threadKey(scope), requestedBy: "pin-ai-channex", status: "SENT",
        }, select: { response: true }, orderBy: { createdAt: "desc" }, take: 100 }),
        db.messageLog.findMany({ where: {
          organizationId: scope.organizationId,
          propertyId: scope.propertyId,
          to: scope.threadId,
          channel: "channex", provider: "channex", status: "SENT",
          communicationType: { in: ["PRECHECKIN", "GUEST_ACCESS_PASSCODE", "CHECKOUT"] },
          providerMessageId: { in: ids },
          OR: [
            { body: { contains: '"kind":"PIN_GO_AIRBNB_DELIVERY"' } },
            { body: { contains: '"kind":"PIN_GO_OTA_OPERATIONAL_DELIVERY"' } },
          ],
        }, select: { providerMessageId: true }, take: ids.length }),
      ]);
      const own = new Set(receipts.flatMap(r => {
        const id = r.response && typeof r.response === "object" && !Array.isArray(r.response) ? r.response.id : null;
        return typeof id === "string" && ids.includes(id) ? [id] : [];
      }));
      for (const receipt of operational) {
        if (receipt.providerMessageId && ids.includes(receipt.providerMessageId)) {
          own.add(receipt.providerMessageId);
        }
      }
      return own;
    },
  };
}
export type AutoRepository = ReturnType<typeof createAutoRepository>;
