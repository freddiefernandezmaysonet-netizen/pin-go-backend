import assert from 'node:assert/strict';
import test from 'node:test';
import {createExpoHostPushProvider} from './host-mobile-push-provider.js';
const secret = 'synthetic_access_token_123';
const payload = {title: 'Guest incident needs attention', body: 'Open Pin&Go Host to review the latest status.', data: {
  version: 1, eventId: 'event', organizationId: 'org', propertyId: 'property', target: 'incidents' as const,
}};
const expiresAt = new Date('2026-10-18T00:00:00Z');
function provider(value: unknown, status = 200) {
  return createExpoHostPushProvider(secret, (async () => new Response(JSON.stringify(value), {status})) as typeof fetch);
}
test('one fixed HTTPS request, exact ticket correlation, Host channel and finite expiration', async () => {
  let calls = 0;
  const p = createExpoHostPushProvider(secret, (async (url, init) => {
    calls++;
    assert.equal(url, 'https://exp.host/--/api/v2/push/send');
    assert.equal(init?.redirect, 'error');
    assert.deepEqual(JSON.parse(String(init?.body)), [{to: 'synthetic-token', ...payload,
      channelId: 'host-operations', sound: 'default', expiration: expiresAt.getTime() / 1000}]);
    return new Response(JSON.stringify({data: [{status: 'ok', id: 'ticket-1'}]}));
  }) as typeof fetch);
  assert.deepEqual(await p.send('synthetic-token', payload, expiresAt), {state: 'ACCEPTED', ticketId: 'ticket-1'});
  assert.equal(calls, 1);
});
test('ambiguous network/5xx/malformed responses never hide a resend or claim delivery', async () => {
  for (const p of [provider({}, 503), provider({data: []}), provider({data: [{status: 'ok'}]}), provider({data: [{status: 'ok', id: 'a'}, {status: 'ok', id: 'b'}]}),
    createExpoHostPushProvider(secret, (async () => {throw Error('PRIVATE provider error');}) as typeof fetch)]) {
    assert.deepEqual(await p.send('synthetic-token', payload, expiresAt), {state: 'UNKNOWN', code: 'SEND_OUTCOME_UNKNOWN'});
  }
});
test('only explicit rate rejection is retryable; device retirement is a typed result', async () => {
  assert.deepEqual(await provider({}, 429).send('token', payload, expiresAt), {state: 'RETRY', code: 'RATE_LIMITED'});
  assert.deepEqual(await provider({}, 401).send('token', payload, expiresAt), {state: 'FAILED', code: 'PROVIDER_REJECTED'});
  assert.deepEqual(await provider({data: [{status: 'error', details: {error: 'DeviceNotRegistered'}, message: 'PRIVATE'}]}).send('token', payload, expiresAt),
    {state: 'FAILED', code: 'DEVICE_NOT_REGISTERED'});
});
test('receipts distinguish provider acceptance, missing receipts and retired devices without returning private errors', async () => {
  for (const [value, expected] of [
    [{data: {'ticket-1': {status: 'ok'}}}, {state: 'PROVIDER_ACCEPTED'}],
    [{data: {}}, {state: 'PENDING'}],
    [{data: {'ticket-1': {status: 'error', message: 'PRIVATE', details: {error: 'DeviceNotRegistered'}}}}, {state: 'FAILED', code: 'DEVICE_NOT_REGISTERED'}],
    [{data: {'ticket-1': {status: 'error', details: {error: 'MessageRateExceeded'}}}}, {state: 'FAILED', code: 'PROVIDER_REJECTED'}],
  ]) assert.deepEqual(await provider(value).receipt('ticket-1'), expected);
});
test('deadline covers hung fetch and hung JSON, including adapters ignoring AbortSignal', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  for (const fetcher of [async () => new Promise<Response>(() => {}), async () => ({status: 200, ok: true, json: () => new Promise(() => {})})]) {
    const p = createExpoHostPushProvider(secret, fetcher as typeof fetch);
    const result = p.send('token', payload, expiresAt);
    t.mock.timers.tick(10_001);
    assert.deepEqual(await result, {state: 'UNKNOWN', code: 'SEND_OUTCOME_UNKNOWN'});
  }
});
