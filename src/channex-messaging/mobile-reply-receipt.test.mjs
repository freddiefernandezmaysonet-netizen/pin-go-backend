import assert from 'node:assert/strict';
import test from 'node:test';
import { readMobileReplyReceipt } from './mobile-reply-receipt.ts';
const scope = { organizationId: 'org', requestedBy: 'host', propertyId: 'property', threadId: '11111111-1111-4111-8111-111111111111', requestKey: 'mobile-test-key' };
test('receipt lookup is scoped and returns only acceptance metadata', async () => {
  const result = await readMobileReplyReceipt(scope, async input => {
    assert.deepEqual(input, scope);
    return { status: 'SENT', response: { id: scope.threadId, text: 'private text' } };
  });
  assert.deepEqual(result, { status: 'ACCEPTED', requestKey: scope.requestKey, messageId: scope.threadId });
});
test('missing, pending and unknown receipts never authorize another send', async () => {
  for (const receipt of [null, { status: 'PENDING' }, { status: 'UNKNOWN' }, { status: 'OTHER' }]) {
    assert.equal((await readMobileReplyReceipt(scope, async () => receipt)).status, 'UNCONFIRMED');
  }
});
test('invalid requests and malformed sent receipts fail closed', async () => {
  for (const change of [{ requestKey: '' }, { threadId: '../other' }, { propertyId: '../other' }]) {
    await assert.rejects(readMobileReplyReceipt({ ...scope, ...change }, async () => { assert.fail('must not query'); }));
  }
  await assert.rejects(readMobileReplyReceipt(scope, async () => ({ status: 'SENT', response: null })));
});
