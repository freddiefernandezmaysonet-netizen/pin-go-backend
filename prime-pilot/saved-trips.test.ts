import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { savedTripStore } from './saved-trips.js';
import { createPilotApp } from './app.js';
import { emptyCriteria } from './search.js';

test('saved plans persist criteria only, deduplicate retries, update at capacity and delete individually', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prime-plans-'));
  try {
    const store = savedTripStore(dir);
    const input = { title: 'Escapada', criteria: { ...emptyCriteria, destination: 'Puerto Rico', preferences: ['private_pool'] as typeof emptyCriteria.preferences, unsupported: ['a cinco minutos caminando'] } };
    const first = store.save(input); assert.ok(first.trip); assert.equal(first.created, true);
    assert.equal(store.save(input).trip?.id, first.trip.id);
    const reopened = savedTripStore(dir); assert.deepEqual(reopened.list()[0].criteria, input.criteria);
    assert.equal(statSync(join(dir, 'saved-trips.json')).mode & 0o777, 0o600);
    for (let n = 1; n < 20; n++) store.save({ ...input, title: 'Plan ' + n });
    assert.equal(store.save({ ...input, title: 'Extra' }).error, 'SAVED_TRIP_LIMIT');
    const update = store.save({ ...input, title: 'Escapada actualizada', criteria: { ...input.criteria, maxTotal: 500 } }, first.trip.id);
    assert.equal(update.trip?.criteria.maxTotal, 500); assert.equal(store.list().length, 20);
    assert.equal(update.trip?.createdAt, first.trip.createdAt);
    assert.equal(store.save(input, randomUUID()).error, 'TRIP_NOT_FOUND');
    assert.equal(store.remove(first.trip.id), true); assert.equal(store.remove(first.trip.id), false);
    assert.equal(reopened.list().length, 19);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('corrupt or wrong-member plan storage fails without overwriting existing data', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prime-plans-invalid-'));
  const path = join(dir, 'saved-trips.json');
  try {
    for (const raw of ['not-json', JSON.stringify({ version: 1, member: 'someone-else', trips: [] })]) {
      writeFileSync(path, raw);
      assert.throws(() => savedTripStore(dir).save({ title: 'Trip', criteria: { ...emptyCriteria, destination: 'PR' } }));
      assert.equal(readFileSync(path, 'utf8'), raw);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('plan API enforces session, origin and schema; resume rechecks live inventory without a saved quote', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'prime-plans-api-'));
  const invitation = 'plans-test-invitation-'.repeat(4);
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ PRIME_OPENAI_API_KEY: 'not-a-real-key-'.repeat(5), invitationHash: createHash('sha256').update(invitation).digest('hex'), sessionSecret: 'b'.repeat(64), expiresAt: Date.now() + 60000 }));
  let reads = 0;
  const app = createPilotApp({ dataDir, production: false, catalog: { catalog: async () => { reads++; return []; }, available: async () => { throw new Error('not reached'); }, quote: async () => { throw new Error('not reached'); } }, interpret: async () => { throw new Error('saving and reopening must not call AI'); } });
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.on('listening', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const headers: Record<string, string> = { Origin: origin, 'Content-Type': 'application/json' };
  const request = (path: string, method = 'GET', body?: unknown, extra = {}) => fetch(origin + path, { method, headers: { ...headers, ...extra }, body: body ? JSON.stringify(body) : undefined });
  try {
    assert.equal((await request('/api/saved-trips')).status, 401);
    assert.equal((await request('/api/saved-trips', 'POST', {})).status, 401);
    const login = await request('/api/session', 'POST', { invitation }); headers.Cookie = login.headers.get('set-cookie')!.split(';')[0];
    const criteria = { ...emptyCriteria, destination: 'Puerto Rico', checkIn: '2099-11-06', checkOut: '2099-11-09', adults: 2 };
    const body = { title: 'Viaje de prueba', criteria };
    assert.equal((await request('/api/saved-trips', 'POST', body, { Origin: 'https://other.example' })).status, 403);
    assert.equal((await request('/api/saved-trips', 'POST', { ...body, quote: { total: 1 }, history: [] })).status, 400);
    assert.equal((await request('/api/saved-trips', 'POST', { ...body, criteria: emptyCriteria })).status, 400);
    const saved = await request('/api/saved-trips', 'POST', body); assert.equal(saved.status, 201);
    const { trip } = await saved.json(); assert.equal(trip.status, 'PLANNING'); assert.equal(reads, 0);
    const path = '/api/saved-trips/' + trip.id;
    assert.equal((await request(path, 'PUT', body, { Origin: 'https://other.example' })).status, 403);
    assert.equal((await request(path, 'DELETE', undefined, { Origin: 'https://other.example' })).status, 403);
    assert.equal((await request(path, 'PUT', { ...body, title: 'Cambio', criteria: { ...criteria, minBedrooms: 2 } })).status, 200);
    const list = await (await request('/api/saved-trips')).json(); assert.equal(list.trips.length, 1); assert.equal(list.trips[0].criteria.minBedrooms, 2);
    assert.equal(Object.hasOwn(list.trips[0], 'quote'), false); assert.equal(Object.hasOwn(list.trips[0], 'history'), false);
    const resumed = await (await request('/api/search', 'POST', { criteria: list.trips[0].criteria })).json();
    assert.equal(resumed.status, 'NO_MATCHES'); assert.equal(reads, 1); // A current catalog check, not a stale stored result.
    assert.equal((await request('/api/saved-trips/' + randomUUID(), 'PUT', body)).status, 404);
    assert.equal((await request('/api/saved-trips/not-an-id', 'DELETE')).status, 400);
    assert.equal((await request(path, 'DELETE')).status, 200);
    assert.equal((await (await request('/api/saved-trips')).json()).trips.length, 0);
    assert.equal(reads, 1);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(dataDir, { recursive: true, force: true }); }
});
