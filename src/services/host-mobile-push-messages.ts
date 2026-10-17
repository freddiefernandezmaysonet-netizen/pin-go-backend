import type {PrismaClient} from '@prisma/client';
import {createHostInbox, createInboxHttpRequest, validId, type Scope, type Message, type Thread} from '../channex-messaging/host-inbox.js';
import {resolveOtaConnectionCenterConfig} from '../distribution/ota-connection-center.config.js';
import type {PushSnapshot} from './host-mobile-push-delivery.repository.js';

type History = {thread: Thread; items: Message[]; page: number; limit: number; total: number};
export type MessageVerification = {state: 'READY'; verifiedAt: Date} | {state: 'SKIP' | 'DEFER'};
export type VerifyHostPushMessage = (scope: Scope, message: NonNullable<PushSnapshot['message']>, notBefore: Date) => Promise<MessageVerification>;

// Read-only verification. No message content is returned to the push pipeline.
export function createHostPushMessageVerifier(read: (scope: Scope, threadId: string) => Promise<History>, clock = () => new Date()): VerifyHostPushMessage {
  return async (scope, source, notBefore) => {
    try {
      if (!validId(source.threadId) || !validId(source.messageId)) return {state: 'SKIP'};
      const history = await read(scope, source.threadId);
      if (history.thread.id !== source.threadId || history.page !== 1 || history.items.length > 25 ||
          history.total !== history.thread.messageCount || history.items.length !== Math.min(history.total, 25)) return {state: 'DEFER'};
      if (history.thread.isClosed) return {state: 'SKIP'};
      const ordered = [...history.items].sort((a, b) => Date.parse(b.insertedAt) - Date.parse(a.insertedAt));
      const latest = ordered[0];
      if (!latest) return {state: 'SKIP'};
      const now = clock(), occurred = Date.parse(latest.insertedAt);
      if (!Number.isFinite(notBefore.getTime()) || occurred < notBefore.getTime() || !Number.isFinite(occurred) || occurred > now.getTime() || now.getTime() - occurred >= 86400000) return {state: 'SKIP'};
      // Equal timestamps cannot establish the ordering of a guest/host exchange.
      if (ordered[1] && Date.parse(ordered[1].insertedAt) === occurred) return {state: 'DEFER'};
      const summary = history.thread.lastMessage;
      if (!summary || summary.sender !== latest.sender || Date.parse(summary.insertedAt) !== occurred || summary.text !== latest.text)
        return {state: 'DEFER'};
      if (latest.id !== source.messageId || latest.sender !== 'guest') return {state: 'SKIP'};
      return {state: 'READY', verifiedAt: now};
    } catch { return {state: 'DEFER'}; }
  };
}

export function buildHostPushMessageVerifier(db: PrismaClient, env: Readonly<Record<string, string | undefined>>, fetchImpl?: typeof fetch): VerifyHostPushMessage | undefined {
  if (env.HOST_MOBILE_PUSH_MESSAGES_ENABLED !== 'true') return undefined;
  const config = resolveOtaConnectionCenterConfig(env);
  if (env.CHANNEX_HOST_INBOX_ENABLED !== 'true' || !config.enabled) throw Error('HOST_PUSH_MESSAGES_CONFIG_INVALID');
  const transport = createInboxHttpRequest({apiOrigin: config.provider.apiOrigin, apiKey: config.provider.apiKey, fetchImpl});
  const never = async (): Promise<never> => {throw Error('HOST_PUSH_MESSAGES_READ_ONLY');};
  const inbox = createHostInbox({
    // Defense in depth: even an accidental caller cannot issue a POST.
    request: input => input.method === 'GET' ? transport(input) : never(),
    async resolveProperty(scope) {
      const rows = await db.distributionProperty.findMany({where: {organizationId: scope.organizationId, propertyId: scope.propertyId,
        platform: 'CHANNEX', provisioningStatus: 'READY', property: {organizationId: scope.organizationId, status: 'ACTIVE'},
        group: {organizationId: scope.organizationId, provisioningStatus: 'READY', externalGroupId: {not: null}}},
        select: {externalPropertyId: true}, take: 2});
      if (rows.length !== 1 || !rows[0]!.externalPropertyId || !validId(rows[0]!.externalPropertyId)) throw Error('HOST_PUSH_MESSAGES_SCOPE_INVALID');
      return rows[0]!.externalPropertyId;
    },
    reserve: never, complete: never, unknown: never,
  });
  return createHostPushMessageVerifier((scope, threadId) => inbox.messages(scope, threadId, {page: 1, limit: 25}));
}
