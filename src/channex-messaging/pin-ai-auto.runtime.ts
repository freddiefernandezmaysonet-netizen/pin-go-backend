import type { PrismaClient } from "@prisma/client";
import { InboxError, type createHostInbox } from "./host-inbox.js";
import { autoConfig, parseMessageEvent } from "./pin-ai-auto.policy.js";
import { createAutoRepository, type AIThreadScope } from "./pin-ai-auto.repository.js";
import { createAutomaticResponder } from "./pin-ai-auto.service.js";
import { buildPinAIInboxDraftRuntime } from "./pin-ai-draft.runtime.js";

export function buildAutomaticInbox(args: { prisma: PrismaClient; env: NodeJS.ProcessEnv; inbox: ReturnType<typeof createHostInbox> }) {
  const config = () => autoConfig(args.env), repository = createAutoRepository(args.prisma);
  const generate = buildPinAIInboxDraftRuntime({ ...args, messages: args.inbox.messages, automatic: true });
  const process = createAutomaticResponder({ repository, enabled: job => config().allows(job),
    messages: job => args.inbox.messages(job, job.threadId, { page: 1, limit: 25 }), generate, send: args.inbox.reply });
  return {
    async receive(body: unknown) {
      const event = parseMessageEvent(body);
      if (!event) return { ignored: true };
      const mappings = await args.prisma.distributionProperty.findMany({ where: { platform: "CHANNEX", externalPropertyId: event.externalPropertyId,
        provisioningStatus: "READY", property: { status: "ACTIVE" }, group: { provisioningStatus: "READY", externalGroupId: { not: null } } },
        select: { organizationId: true, propertyId: true, property: { select: { organizationId: true } }, group: { select: { organizationId: true } } }, take: 2 });
      const mapping = mappings[0];
      if (mappings.length !== 1 || !mapping || mapping.property.organizationId !== mapping.organizationId || mapping.group?.organizationId !== mapping.organizationId || !config().allows(mapping)) return { ignored: true };
      await repository.enqueue({ organizationId: mapping.organizationId, propertyId: mapping.propertyId, threadId: event.threadId, messageId: event.messageId });
      return { ignored: false };
    },
    async runNext() {
      if (!config().enabled) return false;
      for (const candidate of await repository.candidates()) {
        const job = await repository.claim(candidate, config().since);
        if (!job) continue;
        await process(job);
        return true;
      }
      return false;
    },
    async state(scope: AIThreadScope) {
      if (!config().allows(scope)) return { enabled: false, mode: "OFF", reason: null, sending: false };
      const row = await repository.state(scope);
      return { enabled: true, mode: row?.mode ?? "AUTO", reason: row?.reason ?? null, sending: row?.sending ?? false };
    },
    async needsHost(scope: Omit<AIThreadScope, "threadId">, threadIds: string[]) {
      if (!config().allows(scope)) return new Set<string>();
      const rows = await args.prisma.channexAIThread.findMany({ where: { ...scope, threadId: { in: threadIds }, mode: "HUMAN" }, select: { threadId: true } });
      return new Set(rows.map(row => row.threadId));
    },
    async control(scope: AIThreadScope, mode: "AUTO" | "HUMAN") {
      if (!config().allows(scope)) throw new InboxError("PIN_AI_AUTO_DISABLED", 503);
      await args.inbox.messages(scope, scope.threadId, { page: 1, limit: 1 });
      return { enabled: true, ...await repository.control(scope, mode, new Date()) };
    },
    async beforeHostReply(scope: AIThreadScope) {
      if (!config().allows(scope)) return;
      await args.inbox.messages(scope, scope.threadId, { page: 1, limit: 1 });
      const state = await repository.control(scope, "HUMAN", config().since);
      if (state.sending) throw new InboxError("PIN_AI_SEND_IN_PROGRESS", 409);
    },
  };
}
