import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import axios from 'axios';
import { encryptMobileAccessSecret, decryptMobileAccessSecret } from './mobile-access-crypto.service.js';
import { registerAndAuthenticateTTLockRecipient } from './ttlock-recipient-provider.service.js';
process.env.MOBILE_ACCESS_KEY_VERSION = 'test';
process.env.MOBILE_ACCESS_KEYS = JSON.stringify({ test: 'ab'.repeat(32) });
process.env.TTLOCK_CLIENT_ID = 'client';
process.env.TTLOCK_CLIENT_SECRET = 'secret';
const password = 'persisted-test-secret';
const aad = 'mobile-access:ttlock-recipient:v1:identity:password';
const md5 = createHash('md5').update(password).digest('hex');
function fixture(status = 'PENDING', saved = false) {
 const enc = encryptMobileAccessSecret(password, saved ? aad : 'mobile-access:ttlock-recipient:v1:pending:person:bootstrap');
 const row: any = { id: 'identity', guestPersonId: 'person', username: 'opaque@example.test', status,
 passwordCiphertext: enc.ciphertext, passwordKeyVersion: enc.keyVersion, registeredAt: null };
 const prisma: any = { tTLockRecipientIdentity: { findUnique: async () => ({ ...row }), update: async ({ data }: any) => Object.assign(row, data) } };
 return { row, run: () => registerAndAuthenticateTTLockRecipient(prisma, { identityId: row.id, username: row.username }) };
}
const tokens = { access_token: 'access', refresh_token: 'refresh', expires_in: 3600, uid: 123 };
test('persists password before registration and sends exact OAuth contract', async t => {
 const f = fixture(); let calls = 0;
 t.mock.method(axios, 'post', async (url: string, body: any, config: any) => {
 calls++; assert.equal(decryptMobileAccessSecret(f.row.passwordCiphertext, 'test', aad), password);
 if (url.endsWith('/register')) { assert.equal(config.params.password, md5); return { data: { username: 'canonical' } }; }
 assert.ok(f.row.registeredAt); assert.equal(f.row.username, 'canonical');
 assert.deepEqual(Object.fromEntries(body), { client_id: 'client', client_secret: 'secret', username: 'canonical', password: md5, grant_type: 'password' });
 return { data: tokens };
 });
 await f.run(); assert.equal(calls, 2); assert.equal(f.row.status, 'ACTIVE');
});
test('failed token request retries saved credentials without registering again', async t => {
 const f = fixture(); let registrations = 0; let tokenCalls = 0;
 t.mock.method(axios, 'post', async (url: string, body: any) => {
 if (url.endsWith('/register')) { registrations++; return { data: { username: 'canonical' } }; }
 assert.equal(body.get('username'), 'canonical'); assert.equal(body.get('password'), md5);
 return { data: ++tokenCalls === 1 ? {} : tokens };
 });
 await assert.rejects(f.run(), /TOKEN_INCOMPLETE/); await f.run(); assert.equal(registrations, 1); assert.equal(f.row.status, 'ACTIVE');
});
for (const response of [{ errcode: -1, errmsg: 'sensitive' }, {}]) test('invalid registration blocks OAuth: ' + JSON.stringify(response), async t => {
 const f = fixture(); let calls = 0;
 t.mock.method(axios, 'post', async () => { calls++; return { data: response }; });
 await assert.rejects(f.run(), /TTLOCK_RECIPIENT_REGISTER_/); assert.equal(calls, 1); assert.equal(f.row.status, 'FAILED');
});
test('legacy failed identity requires recovery without remote mutation', async t => {
 const f = fixture('FAILED'); const post = t.mock.method(axios, 'post', async () => { throw new Error('must not call'); });
 await assert.rejects(f.run(), /RECOVERY_REQUIRED/); assert.equal(post.mock.callCount(), 0);
});
test('transport errors sanitized while credentials survive', async t => {
 const f = fixture(); t.mock.method(axios, 'post', async () => { throw new Error('secret=do-not-persist'); });
 await assert.rejects(f.run(), /^Error: TTLOCK_RECIPIENT_AUTH_FAILED$/); assert.equal(f.row.lastError, 'TTLOCK_RECIPIENT_AUTH_FAILED');
 assert.equal(decryptMobileAccessSecret(f.row.passwordCiphertext, 'test', aad), password);
});
test('active identity reuses tokens', async t => {
 const f = fixture('ACTIVE', true); Object.assign(f.row, { accessTokenCiphertext: 'x', refreshTokenCiphertext: 'y' });
 const post = t.mock.method(axios, 'post', async () => { throw new Error('must not call'); });
 assert.equal((await f.run()).reused, true); assert.equal(post.mock.callCount(), 0);
});
test('delete-pending identity cannot register', async t => {
 const f = fixture('DELETE_PENDING', true); const post = t.mock.method(axios, 'post', async () => { throw new Error('must not call'); });
 await assert.rejects(f.run(), /NOT_REGISTERABLE/); assert.equal(post.mock.callCount(), 0);
});
