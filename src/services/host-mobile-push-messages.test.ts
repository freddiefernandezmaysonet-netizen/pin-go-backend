import assert from 'node:assert/strict';
import test from 'node:test';
import {buildHostPushMessageVerifier, createHostPushMessageVerifier} from './host-mobile-push-messages.js';
const now = new Date('2026-10-17T10:00:00Z');
const threadId = '11111111-1111-4111-8111-111111111111', messageId = '22222222-2222-4222-8222-222222222222';
const source = {threadId, messageId, sourceRevision: now, threadRevision: now};
const scope = {organizationId: 'org', propertyId: 'property'};
function fixture() {
  const message = {id: messageId, sender: 'guest' as 'guest' | 'property', insertedAt: '2026-10-17T09:59:00Z', text: 'PRIVATE TEXT', attachments: ['PRIVATE LINK']};
  return {thread: {id: threadId, title: 'PRIVATE TITLE', provider: 'airbnb', isClosed: false, bookingId: null,
    messageCount: 1, lastMessage: {...message}, updatedAt: message.insertedAt}, items: [message], page: 1, limit: 25, total: 1};
}
test('inbound verification only returns an identity-free decision after a current guest message read', async () => {
  const result = await createHostPushMessageVerifier(async (s, id) => {assert.deepEqual(s, scope); assert.equal(id, threadId); return fixture();}, () => now)(scope, source, new Date('2026-10-17T09:00:00Z'));
  assert.deepEqual(result, {state: 'READY', verifiedAt: now});
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|22222222/);
});
test('closed, answered, superseded, stale or future messages cannot produce an alert', async () => {
  for (const scenario of ['closed', 'answered', 'superseded', 'stale', 'future', 'cutoff']) {
    const h = fixture();
    if (scenario === 'closed') h.thread.isClosed = true;
    if (scenario === 'answered') h.items[0]!.sender = 'property';
    if (scenario === 'superseded') h.items[0]!.id = '33333333-3333-4333-8333-333333333333';
    if (scenario === 'cutoff') h.items[0]!.insertedAt = '2026-10-17T08:59:00Z';
    if (scenario === 'stale') h.items[0]!.insertedAt = '2026-10-16T09:00:00Z';
    if (scenario === 'future') h.items[0]!.insertedAt = '2026-10-17T11:00:00Z';
    h.thread.lastMessage = {...h.items[0]!};
    assert.deepEqual(await createHostPushMessageVerifier(async () => h, () => now)(scope, source, new Date('2026-10-17T09:00:00Z')), {state: 'SKIP'}, scenario);
  }
});
test('inconsistent pagination, ambiguous order, changed summary and transport errors defer without exposing content', async () => {
  for (const scenario of ['count', 'thread', 'summary', 'tie', 'error']) {
    const h = fixture();
    if (scenario === 'count') h.total = 2;
    if (scenario === 'thread') h.thread.id = 'other';
    if (scenario === 'summary') h.thread.lastMessage.text = 'changed';
    if (scenario === 'tie') {h.items.push({...h.items[0]!, id: 'other', sender: 'property'}); h.total = 2; h.thread.messageCount = 2;}
    const result = await createHostPushMessageVerifier(async () => {if (scenario === 'error') throw Error('PRIVATE'); return h;}, () => now)(scope, source, new Date('2026-10-17T09:00:00Z'));
    assert.deepEqual(result, {state: 'DEFER'}, scenario);
  }
});
test('message adapter is default-off and requires existing inbox/provider configuration', () => {
  const db = new Proxy({}, {get: () => {throw Error('no DB access');}}) as any;
  assert.equal(buildHostPushMessageVerifier(db, {}), undefined);
  assert.throws(() => buildHostPushMessageVerifier(db, {HOST_MOBILE_PUSH_MESSAGES_ENABLED: 'true'}), /CONFIG_INVALID/);
});
test('runtime adapter uses only scoped GETs and rejects absent or ambiguous property mappings', async () => {
  const remote = '44444444-4444-4444-8444-444444444444';
  const env = {HOST_MOBILE_PUSH_MESSAGES_ENABLED: 'true', CHANNEX_HOST_INBOX_ENABLED: 'true', OTA_CONNECTION_CENTER_ENABLED: 'true',
    OTA_CONNECTION_PROVIDER_API_ORIGIN: 'https://staging.channex.io', OTA_CONNECTION_IFRAME_BASE_URL: 'https://staging.channex.io/channels',
    OTA_CONNECTION_API_KEY: 'synthetic', OTA_CONNECTION_DEFAULT_CURRENCY: 'USD', OTA_CONNECTION_AIRBNB_FILTER: 'AIRBNB',
    OTA_CONNECTION_BOOKING_FILTER: 'BOOKING', OTA_CONNECTION_VRBO_FILTER: 'VRBO', NODE_ENV: 'test'};
  let mappingCount = 1; const requests: string[] = [];
  const db = {distributionProperty: {findMany: async ({where}: any) => {
    assert.equal(where.organizationId, scope.organizationId); assert.equal(where.propertyId, scope.propertyId);
    assert.equal(where.property.organizationId, scope.organizationId); assert.equal(where.group.organizationId, scope.organizationId);
    return Array.from({length: mappingCount}, () => ({externalPropertyId: remote}));
  }}} as any;
  const insertedAt = new Date(Date.now() - 1000).toISOString();
  const attrs = {sender: 'guest', inserted_at: insertedAt, message: 'PRIVATE', attachments: []};
  const fetchImpl: typeof fetch = async (url, init) => {
    assert.equal(init?.method, 'GET'); assert.equal(init?.body, undefined); requests.push(String(url));
    return new Response(JSON.stringify(String(url).includes('/messages?') ? {
      data: [{type: 'message', id: messageId, attributes: attrs, relationships: {message_thread: {data: {type: 'message_thread', id: threadId}}}}],
      meta: {page: 1, limit: 25, total: 1},
    } : {data: {type: 'message_thread', id: threadId, attributes: {title: 'PRIVATE', provider: 'airbnb', is_closed: false,
      message_count: 1, last_message: attrs, updated_at: insertedAt}, relationships: {property: {data: {type: 'property', id: remote}}}}}), {status: 200});
  };
  const verify = buildHostPushMessageVerifier(db, env, fetchImpl)!;
  assert.equal((await verify(scope, source, new Date(Date.now() - 60000))).state, 'READY');
  assert.equal(requests.length, 2);
  for (mappingCount of [0, 2]) {
    assert.deepEqual(await verify(scope, source, now), {state: 'DEFER'});
    assert.equal(requests.length, 2, 'invalid mapping must not reach the provider');
  }
});
