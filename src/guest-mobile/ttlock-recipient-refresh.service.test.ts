import assert from 'node:assert/strict';
import test from 'node:test';
import axios from 'axios';
import { encryptMobileAccessSecret } from './mobile-access-crypto.service.js';
import { TTLockMobileAccessProvider } from './ttlock-mobile-access-provider.js';
process.env.MOBILE_ACCESS_KEY_VERSION = 'test';
process.env.MOBILE_ACCESS_KEYS = JSON.stringify({ test: 'ab'.repeat(32) });
process.env.TTLOCK_CLIENT_ID = 'client';
process.env.TTLOCK_CLIENT_SECRET = 'secret';
test('expired recipient token refresh uses OAuth snake_case credentials', async t => {
 const enc = (kind: string, value: string) => encryptMobileAccessSecret(value, `mobile-access:ttlock-recipient:v1:identity:${kind}`).ciphertext;
 const row: any = { id: 'identity', status: 'ACTIVE', username: 'canonical', tokenKeyVersion: 'test', tokenExpiresAt: new Date(0),
 accessTokenCiphertext: enc('access-token', 'old'), refreshTokenCiphertext: enc('refresh-token', 'refresh') };
 const prisma: any = { tTLockRecipientIdentity: { findUnique: async () => row, update: async ({ data }: any) => Object.assign(row, data) },
 tTLockAuth: { findUnique: async () => ({ accessToken: 'owner', expiresAt: new Date(Date.now() + 3600000) }) } };
 let refreshed = false;
 t.mock.method(axios, 'post', async (url: string, body: any) => {
 if (url.endsWith('/send')) return { data: { keyId: 'key' } };
 assert.ok(url.endsWith('/oauth2/token'));
 assert.deepEqual(Object.fromEntries(body), { client_id: 'client', client_secret: 'secret', refresh_token: 'refresh', grant_type: 'refresh_token' });
 refreshed = true; return { data: { access_token: 'new', refresh_token: 'next', expires_in: 3600 } };
 });
 t.mock.method(axios, 'get', async (_url: string, config: any) => {
 assert.equal(config.params.accessToken, 'new'); return { data: { lockData: 'data', lockMac: 'mac', startDate: 1, endDate: 2 } };
 });
 await new TTLockMobileAccessProvider(prisma, 'org', 'identity').issueTimeboundKey({ providerLockId: 1, recipient: 'canonical', startsAt: new Date(1), endsAt: new Date(2) });
 assert.equal(refreshed, true);
});
