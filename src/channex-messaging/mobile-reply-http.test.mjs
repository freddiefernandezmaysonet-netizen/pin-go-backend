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
  const app = express(); app.use(express.json());
  app.use(buildDashboardChannexHostInboxRouter({ runtime: { async reply(input) { calls.push(input); return { message: { id: 'synthetic' } }; } }, isTrustedOrigin: async () => false }));
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
