import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';

test('mobile HTTP boundary verifies signed tokens and enforced sessions with the canonical auth stack', async t => {
  process.env.JWT_SECRET = 'synthetic-local-test-secret-never-use-in-production';
  process.env.PINGO_SESSION_MODE = 'SHADOW';
  process.env.HOST_MOBILE_REPLY_ENABLED = 'true';
  const { prisma } = await import('../lib/prisma.ts');
  const { signSessionBoundAuthToken } = await import('../auth/session-bound-token.ts');
  const { buildDashboardChannexHostInboxRouter } = await import('../routes/dashboard.channex-host-inbox.route.ts');
  let revoked = false, unavailable = false;
  const userLookup = prisma.dashboardUser.findUnique, sessionLookup = prisma.authSession.findUnique;
  t.after(() => { prisma.dashboardUser.findUnique = userLookup; prisma.authSession.findUnique = sessionLookup; });
  prisma.dashboardUser.findUnique = async () => {
    if (unavailable) throw Error('synthetic database outage');
    return { id: 'host', organizationId: 'org', email: 'test@example.invalid', role: 'ORG_ADMIN', isActive: true, tokenVersion: 2, organization: null };
  };
  prisma.authSession.findUnique = async () => ({
    id: 'session', userId: 'host', organizationId: 'org', tokenVersion: 2,
    authenticatedAt: new Date(), lastActivityAt: new Date(), absoluteExpiresAt: new Date(Date.now() + 60000), revokedAt: revoked ? new Date() : null,
  });
  const calls = [];
  const receiptReads = [];
  const receiptLookup = prisma.channexHostMessageSend.findFirst;
  t.after(() => { prisma.channexHostMessageSend.findFirst = receiptLookup; });
  prisma.channexHostMessageSend.findFirst = async args => {
    receiptReads.push(args);
    return { status: 'SENT', response: { id: '11111111-1111-4111-8111-111111111111' } };
  };
  const messageId = '11111111-1111-4111-8111-111111111111';
  let revokeDuringRead = false; const readWrites = [];
  const readFind = prisma.hostMobileMessageRead.findMany, readWrite = prisma.hostMobileMessageRead.createMany;
  t.after(() => {prisma.hostMobileMessageRead.findMany = readFind; prisma.hostMobileMessageRead.createMany = readWrite; delete process.env.HOST_MOBILE_MESSAGE_READ_ENABLED;});
  prisma.hostMobileMessageRead.findMany = async () => readWrites.map(() => ({messageId}));
  prisma.hostMobileMessageRead.createMany = async args => {readWrites.push(args); return {count: 1};};
  const app = express(); app.use(express.json());
  app.use(buildDashboardChannexHostInboxRouter({ runtime: { async messages(scope, threadId, page) {
    assert.equal(scope.organizationId, 'org'); assert.equal(scope.userId, 'host');
    if (revokeDuringRead) revoked = true;
    return {items: [{id: messageId, sender: 'guest'}], thread: {id: threadId}, ...page, total: 1};
  }, async reply(input) { calls.push(input); return { message: { id: 'synthetic' } }; } }, isTrustedOrigin: async () => false }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const token = signSessionBoundAuthToken({ sub: 'host', orgId: 'org', email: 'test@example.invalid', role: 'ORG_ADMIN', tokenVersion: 2 }, 'session');
  async function send({ headers = {}, body = { text: 'Synthetic only' }, suffix = 'mobile-messages' } = {}) {
    const result = await fetch(`http://127.0.0.1:${server.address().port}/api/dashboard/channex-messages/properties/local/threads/thread/${suffix}`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'idempotency-key': 'synthetic-key-123', connection: 'close', ...headers }, body: JSON.stringify(body),
    });
    return { status: result.status, body: await result.json() };
  }
  try {
    const readUrl = `http://127.0.0.1:${server.address().port}/api/dashboard/channex-messages/properties/local/threads/${messageId}`;
    const readHeaders = {authorization: `Bearer ${token}`, 'content-type': 'application/json', connection: 'close'};
    const markRead = async (body = {messageId, page: 1}, extra = {}) => {
      const response = await fetch(readUrl + '/mobile-read', {method: 'POST', headers: {...readHeaders, ...extra}, body: JSON.stringify(body)});
      await response.json(); return response.status;
    };
    assert.equal(await markRead(), 503); assert.equal(readWrites.length, 0);
    process.env.HOST_MOBILE_MESSAGE_READ_ENABLED = 'true';
    assert.equal(await markRead({messageId, page: 1, userId: 'other'}), 400);
    assert.equal(await markRead({messageId: '22222222-2222-4222-8222-222222222222', page: 1}), 409);
    assert.equal(await markRead(undefined, {origin: 'https://app.pin-ngo.com'}), 403);
    assert.equal(await markRead(undefined, {cookie: 'unexpected=1'}), 403);
    revokeDuringRead = true;
    assert.equal(await markRead(), 401); assert.equal(readWrites.length, 0);
    revokeDuringRead = false; revoked = false;
    assert.equal(await markRead(), 200); assert.equal(readWrites.length, 1);
    assert.equal(readWrites[0].data[0].userId, 'host'); assert.equal(readWrites[0].data[0].organizationId, 'org');
    const readResult = await fetch(readUrl + '/mobile-messages?page=1&limit=25', {headers: readHeaders});
    assert.equal(readResult.status, 200); assert.equal((await readResult.json()).items[0].read, true);
    const receiptUrl = `http://127.0.0.1:${server.address().port}/api/dashboard/channex-messages/properties/local/threads/11111111-1111-4111-8111-111111111111/mobile-receipt`;
    const receiptHeaders = { authorization: `Bearer ${token}`, 'idempotency-key': 'synthetic-key-123', connection: 'close' };
    const receipt = await fetch(receiptUrl, { headers: receiptHeaders });
    assert.equal(receipt.status, 200); assert.equal(receipt.headers.get('cache-control'), 'no-store');
    assert.equal((await receipt.json()).status, 'ACCEPTED');
    assert.deepEqual(receiptReads[0], { where: { organizationId: 'org', requestedBy: 'host', propertyId: 'local', threadId: '11111111-1111-4111-8111-111111111111', requestKey: 'synthetic-key-123' }, select: { status: true, response: true } });
    revoked = true;
    const denied = await fetch(receiptUrl, { headers: receiptHeaders });
    assert.equal(denied.status, 401); await denied.json(); assert.equal(receiptReads.length, 1);
    revoked = false;
    assert.equal((await send()).status, 200);
    assert.deepEqual(calls, [{ organizationId: 'org', requestedBy: 'host', propertyId: 'local', threadId: 'thread', text: 'Synthetic only', requestKey: 'synthetic-key-123' }]);
    assert.equal((await send({ body: { text: 'Synthetic only', organizationId: 'other' } })).status, 400);
    assert.equal((await send({ headers: { origin: 'https://app.pin-ngo.com' } })).status, 403);
    assert.equal((await send({ headers: { cookie: 'unexpected=1' } })).status, 403);
    assert.equal((await send({ headers: { authorization: 'Bearer invalid.signature.token' } })).status, 401);
    assert.equal((await send({ suffix: 'messages' })).status, 403);
    revoked = true;
    assert.equal((await send()).status, 401);
    revoked = false; unavailable = true;
    assert.equal((await send()).status, 503);
    unavailable = false; delete process.env.HOST_MOBILE_REPLY_ENABLED;
    assert.equal((await send()).status, 503);
    assert.equal(calls.length, 1);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await prisma.$disconnect();
  }
});
