import { InboxError } from './host-inbox.js';

type Scope = { organizationId: string; requestedBy: string; propertyId: string; threadId: string; requestKey: string };
export async function readMobileReplyReceipt(scope: Scope, find: (scope: Scope) => Promise<{ status: string; response: unknown } | null>) {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(scope.propertyId) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(scope.threadId) ||
      !/^[a-zA-Z0-9_-]{8,120}$/.test(scope.requestKey)) throw new InboxError('HOST_INBOX_RECEIPT_INVALID', 400);
  const receipt = await find(scope);
  // Absence is not proof of a failed send: an original request may still arrive.
  if (receipt?.status !== 'SENT') return { status: 'UNCONFIRMED' as const, requestKey: scope.requestKey };
  const response = receipt.response as { id?: unknown } | null;
  if (typeof response?.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(response.id))
    throw new InboxError('HOST_INBOX_RECEIPT_UNAVAILABLE', 503);
  return { status: 'ACCEPTED' as const, requestKey: scope.requestKey, messageId: response.id };
}
