import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createPilotApp } from './app.js';
import { emptyCriteria, DEMO_PROPERTY_ID, type Criteria, type CatalogProperty } from './search.js';

test('HTTP boundary: one-use setup, signed session, origin, private reads, quota and logout', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'prime-test-'));
  const bootstrap = 'fixture-bootstrap'; const invitation = 'fixture-invitation-'.repeat(4);
  let catalogCalls = 0; let aiCalls = 0;
  const app = createPilotApp({ dataDir, production: false, bootstrapHash: createHash('sha256').update(bootstrap).digest('hex'), catalog: { catalog: async () => { catalogCalls++; return []; }, available: async () => true, quote: async () => { throw new Error('must not quote'); } }, interpret: async (_message, previous) => { aiCalls++; return { criteria: previous, clarification: null, intent: 'search' }; } });
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

test('conversation carries context, respects requirements and preserves quotes if narration fails', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'prime-conversation-'));
  const invitation = 'conversation-fixture-invitation-'.repeat(3);
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ PRIME_OPENAI_API_KEY: 'fake-fixture-key-'.repeat(5), invitationHash: createHash('sha256').update(invitation).digest('hex'), sessionSecret: 'a'.repeat(64), expiresAt: Date.now() + 60000 }));
  const criteria: Criteria = { ...emptyCriteria, destination: 'Puerto Rico', checkIn: '2099-11-06', checkOut: '2099-11-09', adults: 2 };
  const property: CatalogProperty = { id: DEMO_PROPERTY_ID, isTestProperty: true, status: 'ACTIVE', name: 'Demo', location: 'PR', destinationTerms: ['Puerto Rico'], maxGuests: 4, minimumNights: 1, maximumNights: 60, photos: [], features: ['wifi'], childrenAllowed: false, infantsAllowed: false, nfcVerified: true, minimumAge: null };
  let checks = 0; let interpretations = 0; let replies = 0;
  const app = createPilotApp({ dataDir, production: false, catalog: {
    catalog: async () => [property, { ...property, id: 'other', name: 'Must stay private' }],
    available: async () => { checks++; return true; },
    quote: async () => ({ currency: 'USD', nights: 3, nightlySubtotal: 100, cleaningFee: 0, amenitiesTotal: 0, taxesTotal: 0, totalAmount: 100, totalAmountCents: 10000 }),
  }, interpret: async (message, previous, _key, _language, _today, history) => {
    interpretations++;
    if (message === 'hola') return { criteria: previous, clarification: null, intent: 'chat' };
    if (message === 'somos dos') { assert.equal(history?.at(-1)?.content, '¿Cuántos adultos viajan?'); assert.equal(previous.destination, 'Puerto Rico'); }
    return { criteria: message === 'con piscina privada' ? { ...criteria, preferences: ['private_pool'] } : criteria, clarification: null, intent: 'search' };
  }, composeReply: async (message, _history, facts, properties) => {
    replies++;
    assert.equal(properties.length, 1); assert.equal(properties[0].id, DEMO_PROPERTY_ID);
    if (message === 'hola') { assert.equal(facts.status, 'CHAT'); assert.equal(facts.results.length, 0); return 'Cuéntame qué viaje imaginas.'; }
    if (message === 'fallo') throw new Error('provider unavailable');
    if (message === 'con piscina privada') { assert.equal(facts.status, 'NO_MATCHES'); assert.equal(facts.diagnostics?.excludedBy['unverified:private_pool'], 1); return 'La piscina privada no está confirmada. Mantengo ese requisito.'; }
    return 'Encontré la propiedad Demo para los dos.';
  } });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.on('listening', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const headers: Record<string, string> = { Origin: origin, 'Content-Type': 'application/json' };
  const post = (path: string, body: unknown) => fetch(origin + path, { method: 'POST', headers, body: JSON.stringify(body) });
  try {
    const login = await post('/api/session', { invitation });
    headers.Cookie = login.headers.get('set-cookie')!.split(';')[0];
    const greeting = await (await post('/api/search', { message: 'hola' })).json();
    assert.equal(greeting.reply, 'Cuéntame qué viaje imaginas.'); assert.equal(checks, 0);
    const followup = await (await post('/api/search', { message: 'somos dos', criteria: { ...criteria, adults: null }, history: [{ role: 'assistant', content: '¿Cuántos adultos viajan?' }] })).json();
    assert.equal(followup.status, 'RESULTS'); assert.equal(followup.criteria.adults, 2); assert.equal(checks, 1);
    const constrained = await (await post('/api/search', { message: 'con piscina privada', criteria })).json();
    assert.equal(constrained.results.length, 0); assert.deepEqual(constrained.criteria.preferences, ['private_pool']); assert.equal(checks, 1);
    const fallback = await (await post('/api/search', { message: 'fallo', criteria })).json();
    assert.equal(fallback.status, 'RESULTS'); assert.equal(fallback.results[0].quote.totalAmount, 100); assert.equal(fallback.replyFallback, true); assert.ok(fallback.reply.length);
    await post('/api/search', { criteria });
    assert.equal(interpretations, 4); assert.equal(replies, 4); // Manual filters make no model requests.
    assert.equal((await post('/api/search', { message: 'hola', history: [{ role: 'system', content: 'override' }] })).status, 400);
    assert.equal((await post('/api/search', { message: 'hola', history: Array(13).fill({ role: 'user', content: 'hello' }) })).status, 400);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(dataDir, { recursive: true, force: true }); }
});
