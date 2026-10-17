import assert from 'node:assert/strict';
import test from 'node:test';
import {createHostPushRegistry} from './host-mobile-notification.registry.js';
import {decryptHostPushToken, HOST_PUSH_PROJECT} from './host-mobile-push-token.js';

const token = 'ExpoPushToken[synthetic_token_123456789]';
async function encrypted(keyId = 'old') {
  let row: any;
  const env = {HOST_MOBILE_PUSH_TOKEN_KEY_ID: keyId, HOST_MOBILE_PUSH_TOKEN_KEYS: JSON.stringify({old: 'ab'.repeat(32), next: 'cd'.repeat(32)})};
  const db: any = {hostMobilePushDevice: {upsert: async ({create}: any) => { row = create; }}};
  await createHostPushRegistry(db, env).register({id: 'host', orgId: 'org', sessionId: 'session'}, {token, platform: 'ios', projectId: HOST_PUSH_PROJECT});
  return {row, env};
}
test('reads existing registry ciphertext and old key versions during rotation', async () => {
  const {row, env} = await encrypted();
  assert.equal(decryptHostPushToken(row, {...env, HOST_MOBILE_PUSH_TOKEN_KEY_ID: 'next'}), token);
  const next = await encrypted('next');
  assert.equal(JSON.parse(next.row.tokenCiphertext).keyId, 'next');
  assert.equal(decryptHostPushToken(next.row, next.env), token);
  assert.equal(JSON.stringify(row).includes(token), false);
});
test('rejects tenant, user, session, hash, project and ciphertext tampering without leaking material', async () => {
  const {row, env} = await encrypted();
  for (const patch of [{organizationId: 'other'}, {userId: 'other'}, {sessionId: 'other'}, {tokenHash: 'aa'.repeat(32)},
    {projectId: 'guest'}, {platform: 'web'}, {tokenCiphertext: token},
    {tokenCiphertext: row.tokenCiphertext.replace('"version":1', '"version":2')}]) {
    assert.throws(() => decryptHostPushToken({...row, ...patch}, env), {message: 'HOST_PUSH_TOKEN_UNAVAILABLE'});
  }
  for (const ring of ['{}', 'null', '{"old":"invalid"}', 'invalid'])
    assert.throws(() => decryptHostPushToken(row, {HOST_MOBILE_PUSH_TOKEN_KEYS: ring}), {message: 'HOST_PUSH_TOKEN_UNAVAILABLE'});
});
