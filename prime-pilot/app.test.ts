import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createPilotApp } from './app.js';
import { emptyCriteria } from './search.js';

test('HTTP boundary: one-use setup, signed session, origin, private reads, quota and logout', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'prime-test-'));
  const bootstrap = 'fixture-bootstrap'; const invitation = 'fixture-invitation-'.repeat(4);
  let catalogCalls = 0; let aiCalls = 0;
  const app = createPilotApp({ dataDir, production: false, bootstrapHash: createHash('sha256').update(bootstrap).digest('hex'), catalog: { catalog: async () => { catalogCalls++; return []; }, available: async () => true, quote: async () => { throw new Error('must not quote'); } }, interpret: async (_message, previous) => { aiCalls++; return { criteria: previous, clarification: null }; } });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.on('listening', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request = (path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) => fetch(origin + path, { method, headers: { 'Content-Type': 'application/json', Origin: origin, ...headers }, body: body ? JSON.stringify(body) : undefined });
  try {
    assert.equal((await request('/api/member')).status, 503);
    assert.equal((await request('/internal/provision', 'POST', {}, { Authorization: 'Bearer wrong' })).status, 404);
    const setup = await request('/internal/provision', 'POST', { apiKey: 'fixture-not-a-real-api-key-'.repeat(3), invitation }, { Authorization: 'Bearer ' + bootstrap });
    assert.equal(setup.status, 200); assert.equal(statSync(join(dataDir, 'config.json')).mode & 0o777, 0o600);
    assert.equal((await request('/internal/provision', 'POST', {}, { Authorization: 'Bearer ' + bootstrap })).status, 404);
    assert.equal((await request('/api/member')).status, 401);
    assert.equal((await request('/api/search', 'POST', { criteria: emptyCriteria })).status, 401);
    assert.equal((await request('/api/session', 'POST', { invitation }, { Origin: 'https://attacker.example' })).status, 403);
    assert.equal((await request('/api/session', 'POST', { invitation: 'wrong' })).status, 401);
    const login = await request('/api/session', 'POST', { invitation });
    assert.equal(login.status, 200); const cookie = login.headers.get('set-cookie')!;
    assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Strict/i);
    const headers = { Cookie: cookie.split(';')[0] };
    assert.equal((await request('/api/member', 'GET', undefined, headers)).status, 200);
    assert.equal((await request('/api/member', 'GET', undefined, { Cookie: headers.Cookie + 'bad' })).status, 401);
    assert.equal(catalogCalls, 0); assert.equal(aiCalls, 0);
    const criteria = { ...emptyCriteria, destination: 'Puerto Rico', checkIn: '2099-11-06', checkOut: '2099-11-09', adults: 2 };
    assert.equal((await request('/api/search', 'POST', { criteria }, headers)).status, 200); assert.equal(catalogCalls, 1);
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Puerto_Rico', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    writeFileSync(join(dataDir, 'usage.json'), JSON.stringify({ day: today, count: 100 }));
    assert.equal((await request('/api/search', 'POST', { criteria, message: 'Hello' }, headers)).status, 429); assert.equal(aiCalls, 0);
    const logout = await request('/api/session', 'DELETE', undefined, headers); assert.equal(logout.status, 200); assert.match(logout.headers.get('set-cookie')!, /Expires=Thu, 01 Jan 1970/);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(dataDir, { recursive: true, force: true }); }
});
