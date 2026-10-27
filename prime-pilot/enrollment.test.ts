import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { enrollmentInputSchema, enrollmentStore } from './enrollment.js';
import { createPilotApp } from './app.js';
import { DEMO_PROPERTY_ID, emptyCriteria, type CatalogProperty } from './search.js';

const property: CatalogProperty = { id: DEMO_PROPERTY_ID, isTestProperty: true, status: 'ACTIVE', name: 'Demo', location: 'PR', destinationTerms: ['Puerto Rico'], maxGuests: 4, minimumNights: 1, maximumNights: 60, photos: [], features: ['wifi'], childrenAllowed: false, infantsAllowed: false, nfcVerified: true, minimumAge: null };
const criteria = { ...emptyCriteria, destination: 'Puerto Rico', checkIn: '2099-11-06', checkOut: '2099-11-09', adults: 2 };
const quote = { currency: 'USD', nights: 3, nightlySubtotal: 300, cleaningFee: 40, amenitiesTotal: 10, taxesTotal: 35, totalAmount: 385, totalAmountCents: 38500 };
const benefits = { nightlyDiscountPercent: 20, earlyCheckInRequest: true, lateCheckoutRequest: true, personalNfc: true };

test('enrollment keeps the existing Demo pilot, stores only drafts and rejects stale or malformed data', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prime-enrollment-')); const path = join(dir, 'demo-prime-enrollment.json');
  try {
    const store = enrollmentStore(dir); const initial = store.read();
    assert.equal(initial.participation, 'ACTIVE'); assert.equal(initial.updatedBy, null); assert.equal(existsSync(path), false);
    assert.equal(enrollmentInputSchema.safeParse({ participation: 'ACTIVE', benefitDraft: benefits, expectedRevision: 0 }).success, false);
    assert.equal(enrollmentInputSchema.safeParse({ participation: 'ACTIVE', benefitDraft: benefits, expectedRevision: 0, confirmPilotOnly: true, propertyId: 'other' }).success, false);
    const next = store.save({ participation: 'PAUSED', benefitDraft: benefits, expectedRevision: 0, confirmPilotOnly: true });
    assert.equal(next.enrollment?.revision, 1); assert.equal(next.enrollment?.version, 2); assert.equal(next.enrollment?.benefitsDraftOnly, true); assert.equal(next.enrollment?.updatedBy, 'prime-pilot-founder');
    assert.equal(statSync(path).mode & 0o777, 0o600); assert.equal(enrollmentStore(dir).read().participation, 'PAUSED');
    assert.equal(store.save({ participation: 'ACTIVE', benefitDraft: benefits, expectedRevision: 0, confirmPilotOnly: true }).error, 'ENROLLMENT_CHANGED');
    assert.equal(store.read().participation, 'PAUSED');
    const invalid = JSON.stringify({ ...store.read(), propertyId: 'another-property' }); writeFileSync(path, invalid);
    assert.throws(() => store.read()); assert.throws(() => store.save({ participation: 'ACTIVE', benefitDraft: benefits, expectedRevision: 1, confirmPilotOnly: true }));
    assert.equal(readFileSync(path, 'utf8'), invalid);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('legacy discounts remain unchanged on read; explicit saves require 5–20% or an unset paused discount', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prime-enrollment-upgrade-')); const path = join(dir, 'demo-prime-enrollment.json');
  try {
    const store = enrollmentStore(dir);
    for (const oldDiscount of [0, 30, 100]) {
      const original = JSON.stringify({ ...store.read(), version: 1, revision: 0, participation: 'ACTIVE', benefitDraft: { ...benefits, nightlyDiscountPercent: oldDiscount } });
      writeFileSync(path, original);
      assert.equal(store.read().benefitDraft.nightlyDiscountPercent, oldDiscount);
      assert.equal(store.read().participation, 'ACTIVE');
      assert.equal(readFileSync(path, 'utf8'), original);
      for (const invalid of [null, 0, 4.99, 20.01, 100, NaN, Infinity]) {
        assert.throws(() => store.save({ participation: 'ACTIVE', benefitDraft: { ...benefits, nightlyDiscountPercent: invalid }, expectedRevision: 0, confirmPilotOnly: true }));
        assert.equal(readFileSync(path, 'utf8'), original);
      }
    }
    const paused = store.save({ participation: 'PAUSED', benefitDraft: { ...benefits, nightlyDiscountPercent: null }, expectedRevision: 0, confirmPilotOnly: true });
    assert.equal(paused.enrollment?.version, 2); assert.equal(paused.enrollment?.participation, 'PAUSED');
    assert.equal(enrollmentStore(dir).read().benefitDraft.nightlyDiscountPercent, null);
    assert.equal(store.read().benefitDraft.personalNfc, true);
    const persistedPaused = readFileSync(path, 'utf8');
    assert.throws(() => store.save({ participation: 'ACTIVE', benefitDraft: { ...benefits, nightlyDiscountPercent: null }, expectedRevision: 1, confirmPilotOnly: true }));
    assert.equal(readFileSync(path, 'utf8'), persistedPaused);
    for (const [index, percentage] of [5, 12.5, 20].entries()) {
      const result = store.save({ participation: 'ACTIVE', benefitDraft: { ...benefits, nightlyDiscountPercent: percentage }, expectedRevision: index + 1, confirmPilotOnly: true });
      assert.equal(result.enrollment?.benefitDraft.nightlyDiscountPercent, percentage);
      assert.equal(enrollmentStore(dir).read().benefitDraft.nightlyDiscountPercent, percentage);
    }
    assert.equal(statSync(path).mode & 0o777, 0o600);
    const invalidV2 = JSON.stringify({ ...store.read(), benefitDraft: { ...benefits, nightlyDiscountPercent: 0 } });
    writeFileSync(path, invalidV2);
    assert.throws(() => store.read());
    assert.equal(readFileSync(path, 'utf8'), invalidV2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

async function fixture(overrides: Partial<Parameters<typeof createPilotApp>[0]> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'prime-enrollment-api-'));
  const invitation = 'enrollment-fixture-invitation-'.repeat(3);
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ PRIME_OPENAI_API_KEY: 'not-a-real-key-'.repeat(5), invitationHash: createHash('sha256').update(invitation).digest('hex'), sessionSecret: 'c'.repeat(64), expiresAt: Date.now() + 60000 }));
  const app = createPilotApp({ dataDir: dir, production: false, catalog: { catalog: async () => [property], available: async () => true, quote: async () => quote }, ...overrides });
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.on('listening', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const headers: Record<string, string> = { Origin: origin, 'Content-Type': 'application/json' };
  const request = (path: string, method = 'GET', body?: unknown, more = {}) => fetch(origin + path, { method, headers: { ...headers, ...more }, body: body ? JSON.stringify(body) : undefined });
  const login = async () => { const response = await request('/api/session', 'POST', { invitation }); headers.Cookie = response.headers.get('set-cookie')!.split(';')[0]; };
  const close = async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); };
  return { dir, request, login, close };
}

test('founder settings enforce session/origin/revision; pausing gates search and drafts never change quotes', async () => {
  let reads = 0;
  const f = await fixture({ catalog: { catalog: async () => { reads++; return [property]; }, available: async () => true, quote: async () => quote } });
  try {
    assert.equal((await f.request('/api/pilot/enrollment')).status, 401);
    assert.equal((await f.request('/api/pilot/enrollment', 'PUT', {})).status, 401);
    await f.login();
    const member = await (await f.request('/api/member')).json(); assert.ok(member.capabilities.includes('PILOT_HOST_SETUP'));
    const input = { participation: 'ACTIVE', benefitDraft: benefits, expectedRevision: 0, confirmPilotOnly: true };
    assert.equal((await f.request('/api/pilot/enrollment', 'PUT', input, { Origin: 'https://other.example' })).status, 403);
    assert.equal((await f.request('/api/pilot/enrollment', 'PUT', { ...input, propertyId: 'another-property' })).status, 400);
    assert.equal((await f.request('/api/pilot/enrollment', 'PUT', { ...input, confirmPilotOnly: false })).status, 400);
    for (const participation of ['ACTIVE', 'PAUSED']) {
      for (const invalid of [0, 4.99, 20.01, 100, '', '10']) {
        assert.equal((await f.request('/api/pilot/enrollment', 'PUT', { ...input, participation, benefitDraft: { ...benefits, nightlyDiscountPercent: invalid } })).status, 400);
      }
    }
    assert.equal(existsSync(join(f.dir, 'demo-prime-enrollment.json')), false);
    assert.equal((await f.request('/api/pilot/enrollment', 'PUT', input)).status, 200);
    const first = await (await f.request('/api/search', 'POST', { criteria })).json();
    assert.equal(first.status, 'RESULTS'); assert.equal(first.results[0].quote.totalAmount, 385); assert.equal(JSON.stringify(first).includes('benefitDraft'), false);
    assert.equal((await f.request('/api/pilot/enrollment', 'PUT', { ...input, participation: 'PAUSED' })).status, 409);
    assert.equal((await f.request('/api/pilot/enrollment', 'PUT', { ...input, participation: 'PAUSED', expectedRevision: 1 })).status, 200);
    const countBeforePause = reads;
    const paused = await (await f.request('/api/search', 'POST', { criteria })).json();
    assert.equal(paused.status, 'CATALOG_PAUSED'); assert.deepEqual(paused.results, []); assert.match(paused.reply, /pausada/); assert.equal(reads, countBeforePause);
    assert.equal(enrollmentStore(f.dir).read().participation, 'PAUSED');
    assert.equal((await f.request('/api/pilot/enrollment', 'PUT', { ...input, expectedRevision: 2 })).status, 200);
    const resumed = await (await f.request('/api/search', 'POST', { criteria })).json();
    assert.equal(resumed.status, 'RESULTS'); assert.equal(resumed.results[0].quote.totalAmount, 385);
    const unsetDiscount = { ...input, participation: 'PAUSED', expectedRevision: 3, benefitDraft: { ...benefits, nightlyDiscountPercent: null } };
    assert.equal((await f.request('/api/pilot/enrollment', 'PUT', unsetDiscount)).status, 200);
    assert.equal((await f.request('/api/pilot/enrollment', 'PUT', { ...unsetDiscount, participation: 'ACTIVE', expectedRevision: 4 })).status, 400);
    const stillPaused = await (await f.request('/api/pilot/enrollment')).json();
    assert.equal(stillPaused.enrollment.revision, 4); assert.equal(stillPaused.enrollment.benefitDraft.nightlyDiscountPercent, null);
    assert.equal((await f.request('/api/pilot/enrollment', 'PUT', { ...input, expectedRevision: 4, benefitDraft: { ...benefits, nightlyDiscountPercent: 5 } })).status, 200);
    writeFileSync(join(f.dir, 'demo-prime-enrollment.json'), 'broken');
    assert.equal((await f.request('/api/pilot/enrollment')).status, 503);
    assert.equal((await f.request('/api/search', 'POST', { criteria })).status, 503);
  } finally { await f.close(); }
});

test('a pause during narration discards both an in-flight available result and its generated claim', async () => {
  let started!: () => void; let finish!: () => void;
  const narrationStarted = new Promise<void>(resolve => { started = resolve; });
  const narrationFinished = new Promise<void>(resolve => { finish = resolve; });
  const f = await fixture({ interpret: async () => ({ criteria, clarification: null, intent: 'search' }), composeReply: async () => { started(); await narrationFinished; return 'Demo disponible por USD 385'; } });
  try {
    await f.login();
    const searching = f.request('/api/search', 'POST', { criteria, message: 'Buscar' });
    await narrationStarted;
    assert.equal((await f.request('/api/pilot/enrollment', 'PUT', { participation: 'PAUSED', benefitDraft: benefits, expectedRevision: 0, confirmPilotOnly: true })).status, 200);
    finish(); const result = await (await searching).json();
    assert.equal(result.status, 'CATALOG_PAUSED'); assert.deepEqual(result.results, []); assert.match(result.reply, /pausada/); assert.equal(result.reply.includes('385'), false);
  } finally { finish(); await f.close(); }
});
