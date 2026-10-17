import assert from 'node:assert/strict';
import test from 'node:test';
import {createHostPushRegistry} from './host-mobile-notification.registry.js';
import {runHostPushDeliveryCycle, hostPushDeliveryConfig} from './host-mobile-push-delivery.service.js';
import type {HostPushProvider, PushSendResult} from './host-mobile-push-provider.js';
import type {Delivery, HostPushDeliveryRepository, PushSnapshot} from './host-mobile-push-delivery.repository.js';
import {HOST_PUSH_PROJECT} from './host-mobile-push-token.js';
const now = new Date('2026-10-17T16:00:00Z');
const env = {HOST_MOBILE_PUSH_DELIVERY_ENABLED: 'true', HOST_MOBILE_PUSH_DELIVERY_PROPERTY_IDS: '["property"]',
  HOST_MOBILE_PUSH_DELIVERY_NOT_BEFORE: '2026-10-17T00:00:00Z', HOST_MOBILE_PUSH_TOKEN_KEY_ID: 'test',
  HOST_MOBILE_PUSH_TOKEN_KEYS: JSON.stringify({test: 'ab'.repeat(32)})};
async function fixture() {
  let device: any;
  await createHostPushRegistry({hostMobilePushDevice: {upsert: async ({create}: any) => {device = create;}}} as any, env)
    .register({id: 'host', orgId: 'org', sessionId: 'session'}, {token: 'ExpoPushToken[synthetic_token_123456789]', platform: 'ios', projectId: HOST_PUSH_PROJECT});
  const row = {id: 'delivery', propertyId: 'property', occurredAt: now, expiresAt: new Date(now.getTime() + 86400000),
    attempts: 0, ticketId: null} as Delivery;
  let snapshot: PushSnapshot | null = {checkedAt: now, preferenceRevision: 1, device,
    event: {id: 'event', propertyId: 'property', organizationId: 'org', kind: 'GUEST_INCIDENT', actionRequired: true,
      state: 'ACTION_REQUIRED', severity: 'WARNING', occurredAt: now},
    recipient: {userId: 'host', organizationId: 'org', activeSession: true, role: 'ORG_ADMIN', allowedPropertyIds: ['property']},
    preference: {enabled: true, kinds: ['GUEST_INCIDENT'], timezone: 'UTC', quietHours: null}};
  const results: any[] = []; let claimed = false, sends = 0, arms = 0, allowArm = true, receipt = false;
  let sendResult: PushSendResult = {state: 'ACCEPTED', ticketId: 'ticket'};
  const repository: HostPushDeliveryRepository = {
    recover: async () => {}, materialize: async () => 1,
    claim: async mode => { if (claimed || (receipt ? mode !== 'RECEIPT' : mode !== 'SEND')) return null; claimed = true; return row; },
    current: async () => snapshot,
    arm: async () => {arms++; return allowArm;},
    finish: async (_row, result) => {results.push(result); return true;},
  };
  const provider: HostPushProvider = {send: async () => {sends++; return sendResult;}, receipt: async () => ({state: 'PROVIDER_ACCEPTED'})};
  return {row, results, repository, provider, get snapshot() {return snapshot!;}, set snapshot(value) {snapshot = value;},
    denyCurrent: () => {snapshot = null;}, denyArm: () => {allowArm = false;},
    asReceipt: () => {receipt = true; row.ticketId = 'ticket';}, setResult: (value: PushSendResult) => {sendResult = value;},
    get sends() {return sends;}, get arms() {return arms;},
    run: (patch = {}) => runHostPushDeliveryCycle({env: {...env, ...patch}, repository, provider: () => provider})};
}
test('disabled delivery performs zero database/provider work; invalid scope fails before work', async () => {
  const never = () => {throw Error('must not run');};
  assert.deepEqual(await runHostPushDeliveryCycle({env: {}, repository: new Proxy({}, {get: never}) as HostPushDeliveryRepository, provider: never}),
    {enabled: false, processed: 0, enqueued: 0});
  for (const patch of [{HOST_MOBILE_PUSH_DELIVERY_PROPERTY_IDS: '[]'}, {HOST_MOBILE_PUSH_DELIVERY_PROPERTY_IDS: '["property","property"]'},
    {HOST_MOBILE_PUSH_DELIVERY_NOT_BEFORE: 'invalid'}]) assert.throws(() => hostPushDeliveryConfig({...env, ...patch}), /CONFIG_INVALID/);
});
test('accepted sends are durably armed and scheduled for receipts, never marked delivered', async () => {
  const f = await fixture(); await f.run();
  assert.equal(f.arms, 1); assert.equal(f.sends, 1);
  assert.deepEqual(f.results, [{state: 'ACCEPTED', code: 'EXPO_ACCEPTED', ticketId: 'ticket', delayMs: 900000}]);
});
test('authority changes, opt-out, quiet hours, changed scope, missing keys and stale leases prevent sending', async () => {
  for (const scenario of ['authority', 'opt-out', 'quiet', 'scope', 'keys', 'lease']) {
    const f = await fixture(); const patch: Record<string, string> = {};
    if (scenario === 'authority') f.denyCurrent();
    if (scenario === 'opt-out') f.snapshot.preference.enabled = false;
    if (scenario === 'quiet') f.snapshot.preference.quietHours = {startHour: 15, endHour: 18, allowCritical: false};
    if (scenario === 'scope') patch.HOST_MOBILE_PUSH_DELIVERY_PROPERTY_IDS = '["other"]';
    if (scenario === 'keys') patch.HOST_MOBILE_PUSH_TOKEN_KEYS = '{}';
    if (scenario === 'lease') f.denyArm();
    await f.run(patch); assert.equal(f.sends, 0, scenario);
    if (scenario === 'quiet' || scenario === 'keys') assert.equal(f.results[0].state, 'QUEUED');
  }
});
test('unknown outcomes are terminal and explicit rate rejections have a bounded backoff', async () => {
  let f = await fixture(); f.setResult({state: 'UNKNOWN', code: 'SEND_OUTCOME_UNKNOWN'}); await f.run();
  assert.equal(f.results[0].state, 'UNKNOWN'); assert.equal(f.sends, 1);
  f = await fixture(); f.setResult({state: 'RETRY', code: 'RATE_LIMITED'}); await f.run();
  assert.equal(f.results[0].state, 'QUEUED'); assert.equal(f.results[0].delayMs, 60000);
  f = await fixture(); f.row.attempts = 2; f.setResult({state: 'RETRY', code: 'RATE_LIMITED'}); await f.run();
  assert.equal(f.results[0].state, 'FAILED');
});
test('receipt recovery is independent of current source/session and never sends again', async () => {
  const f = await fixture(); f.asReceipt(); f.denyCurrent(); await f.run();
  assert.equal(f.sends, 0); assert.equal(f.arms, 0); assert.deepEqual(f.results, [{state: 'PROVIDER_ACCEPTED', code: 'PROVIDER_ACCEPTED'}]);
});
test('provider exceptions after the durable send boundary become unknown', async () => {
  const f = await fixture(); f.provider.send = async () => {throw Error('PRIVATE');}; await f.run();
  assert.equal(f.results[0].state, 'UNKNOWN'); assert.equal(JSON.stringify(f.results).includes('PRIVATE'), false);
});

test('maintenance stays independent, disabled by default and rejects missing or broad tenant scope', async () => {
  const {runMaintenance} = await import('../workers/host-mobile-push.worker.js');
  assert.deepEqual(await runMaintenance(env), {enabled: false, deliveriesDeleted: 0, devicesDeleted: 0});
  for (const ids of [undefined, 'null', '[]', '["org","org"]', '["*"]', '[1]', '{']) {
    await assert.rejects(runMaintenance({HOST_MOBILE_PUSH_MAINTENANCE_ENABLED: 'true',
      HOST_MOBILE_PUSH_MAINTENANCE_ORGANIZATION_IDS: ids}), /MAINTENANCE_CONFIG_INVALID/);
  }
});

test('message delivery requires fresh external verification and rechecks local authority after the read', async () => {
  for (const scenario of ['ready', 'skip', 'defer', 'changed', 'disabled']) {
    const f = await fixture(); f.row.kind = 'GUEST_MESSAGE'; f.row.organizationId = 'org';
    f.snapshot.event.kind = 'GUEST_MESSAGE'; f.snapshot.preference.kinds = ['GUEST_MESSAGE'];
    f.snapshot.message = {threadId: 'thread', messageId: 'message', sourceRevision: now, threadRevision: now};
    let reads = 0;
    await runHostPushDeliveryCycle({env: {...env, HOST_MOBILE_PUSH_MESSAGES_ENABLED: scenario === 'disabled' ? 'false' : 'true'},
      repository: f.repository, provider: () => f.provider, verifyMessage: async () => {
        reads++;
        if (scenario === 'changed') f.denyCurrent();
        return scenario === 'skip' ? {state: 'SKIP'} : scenario === 'defer' ? {state: 'DEFER'} : {state: 'READY', verifiedAt: now};
      }});
    assert.equal(reads, scenario === 'disabled' ? 0 : 1);
    assert.equal(f.sends, scenario === 'ready' ? 1 : 0);
    assert.equal(f.arms, scenario === 'ready' ? 1 : 0);
  }
});
