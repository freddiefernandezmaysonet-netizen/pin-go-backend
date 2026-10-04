import { Prisma, type PrismaClient } from "@prisma/client";
import { resolveOtaConnectionCenterConfig } from "../distribution/ota-connection-center.config.js";
import { createHostInbox, createInboxHttpRequest, InboxError, validId } from "./host-inbox.js";
import { buildPinAIInboxDraftRuntime, pinAIDraftsEnabled } from "./pin-ai-draft.runtime.js";
import { buildAutomaticInbox } from "./pin-ai-auto.runtime.js";
import { attachInboxReservations } from "./host-inbox-reservation.js";

export function buildHostInboxRuntime(args: { prisma: PrismaClient; env: NodeJS.ProcessEnv; fetchImpl?: typeof fetch }) {
  const config = resolveOtaConnectionCenterConfig(args.env);
  if (args.env.CHANNEX_HOST_INBOX_ENABLED !== "true" || !config.enabled) return null;
  const prisma = args.prisma;
  const inbox = createHostInbox({
    request: createInboxHttpRequest({ apiOrigin: config.provider.apiOrigin, apiKey: config.provider.apiKey,
      ...(args.fetchImpl ? { fetchImpl: args.fetchImpl } : {}) }),
    async resolveProperty(scope) {
      const mapping = await prisma.distributionProperty.findFirst({ where: {
        organizationId: scope.organizationId, propertyId: scope.propertyId, platform: "CHANNEX",
        provisioningStatus: "READY", property: { organizationId: scope.organizationId, status: "ACTIVE" },
        group: { organizationId: scope.organizationId, provisioningStatus: "READY", externalGroupId: { not: null } },
      }, select: { externalPropertyId: true } });
      if (!mapping?.externalPropertyId) throw new InboxError("HOST_INBOX_PROPERTY_NOT_FOUND", 404);
      if (!validId(mapping.externalPropertyId)) throw new InboxError("HOST_INBOX_MAPPING_INVALID", 503);
      return mapping.externalPropertyId;
    },
    async reserve(input) {
      const { organizationId, propertyId, threadId, requestedBy, requestKey, fingerprint } = input;
      try {
        const receipt = await prisma.channexHostMessageSend.create({ data: { organizationId, propertyId, threadId, requestedBy, requestKey, fingerprint } });
        return { fresh: true, receipt };
      } catch (error) {
        if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") throw error;
        const receipt = await prisma.channexHostMessageSend.findUnique({ where: { organizationId_requestKey: { organizationId, requestKey } } });
        if (!receipt) throw new InboxError("HOST_INBOX_RECEIPT_UNAVAILABLE", 503);
        return { fresh: false, receipt };
      }
    },
    async complete(organizationId, requestKey, response) {
      await prisma.channexHostMessageSend.update({ where: { organizationId_requestKey: { organizationId, requestKey } },
        data: { status: "SENT", response: JSON.parse(JSON.stringify(response)) as Prisma.InputJsonValue } });
    },
    async unknown(organizationId, requestKey) {
      await prisma.channexHostMessageSend.updateMany({ where: { organizationId, requestKey, status: "PENDING" }, data: { status: "UNKNOWN" } });
    },
  });
  const draft = buildPinAIInboxDraftRuntime({ prisma, env: args.env, messages: inbox.messages });
  const automation = buildAutomaticInbox({ prisma, env: args.env, inbox });
  return { ...inbox, draft, automation,
    async list(scope: Parameters<typeof inbox.list>[0], page: Parameters<typeof inbox.list>[1]) {
      const result = await inbox.list(scope, page);
      const needsHost = await automation.needsHost(scope, result.items.map(t => t.id));
      const items = await attachInboxReservations(prisma, scope, result.items);
      return { ...result, items: items.map(t => ({ ...t, needsHost: needsHost.has(t.id) })) };
    },
    async messages(scope: Parameters<typeof inbox.messages>[0], threadId: string, page: Parameters<typeof inbox.messages>[2]) {
      const result = await inbox.messages(scope, threadId, page);
      const [thread] = await attachInboxReservations(prisma, scope, [result.thread]);
      return { ...result, thread: thread!, automation: await automation.state({ ...scope, threadId }) };
    },
    async reply(input: Parameters<typeof inbox.reply>[0]) {
      await automation.beforeHostReply(input);
      return inbox.reply(input);
    },
    async properties(organizationId: string) {
    const rows = await prisma.distributionProperty.findMany({ where: { organizationId, platform: "CHANNEX", provisioningStatus: "READY",
      externalPropertyId: { not: null }, property: { organizationId, status: "ACTIVE" },
      group: { organizationId, provisioningStatus: "READY", externalGroupId: { not: null } },
    }, select: { property: { select: { id: true, name: true } } }, orderBy: { property: { name: "asc" } }, take: 1000 });
    return { items: rows.map(row => ({ ...row.property, pinAIDraftsEnabled: pinAIDraftsEnabled(args.env, { organizationId, propertyId: row.property.id }) })) };
  } };
}
