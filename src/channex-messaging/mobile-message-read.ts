import type {PrismaClient} from '@prisma/client';
import {InboxError, validId, type Message} from './host-inbox.js';
export type MessageReadScope = {organizationId: string; userId: string; propertyId: string; threadId: string};
export function messageReadInput(body: unknown): {messageId: string; page: number} {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new InboxError('HOST_MESSAGE_READ_INVALID', 400);
  const value = body as Record<string, unknown>;
  if (Object.keys(value).some(k => !['messageId', 'page'].includes(k)) || typeof value.messageId !== 'string' ||
      !validId(value.messageId) || !Number.isSafeInteger(value.page) || Number(value.page) < 1 || Number(value.page) > 10000)
    throw new InboxError('HOST_MESSAGE_READ_INVALID', 400);
  return {messageId: value.messageId, page: Number(value.page)};
}
export function createMobileMessageReads(db: Pick<PrismaClient, 'hostMobileMessageRead'>) {
  return {
    async decorate(scope: MessageReadScope, items: Message[]) {
      const ids = items.filter(m => m.sender === 'guest').map(m => m.id);
      if (items.length > 25) throw new InboxError('HOST_MESSAGE_READ_INVALID', 400);
      const receipts = ids.length ? await db.hostMobileMessageRead.findMany({where: {...scope, messageId: {in: ids}}, select: {messageId: true}}) : [];
      const read = new Set(receipts.map(r => r.messageId));
      return items.map(m => ({...m, read: m.sender === 'guest' ? read.has(m.id) : null}));
    },
    async mark(scope: MessageReadScope, messageId: string, canonicalItems: Message[]) {
      if (!validId(scope.threadId) || !validId(messageId) || canonicalItems.length > 25 ||
          !canonicalItems.some(m => m.id === messageId && m.sender === 'guest')) throw new InboxError('HOST_MESSAGE_NOT_VISIBLE', 409);
      // Atomic INSERT ON CONFLICT DO NOTHING is idempotent; reading one message never acknowledges
      // newer, off-page messages or another Host's inbox. No provider write.
      const key = {...scope, messageId};
      await db.hostMobileMessageRead.createMany({data: [key], skipDuplicates: true});
      return {messageId, read: true as const};
    },
  };
}
