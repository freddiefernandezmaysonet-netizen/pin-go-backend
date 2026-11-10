import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { preserveChannexMaskedBooking, unmaskChannexContact } from './ota-masked-booking.policy';

const previous = { provider: 'CHANNEX', booking: { customer: { mail: 'guest@example.com', phone: '+17875550123', address: 'Test address', city: 'Test city', state: 'PR', zip: '00000', country: 'US' }, notes: 'Late arrival', raw_message: 'Original message', status: 'new' } };
const incoming = { provider: 'CHANNEX', revisionIdentity: { revisionId: 'new' }, booking: { customer: Object.fromEntries(Object.keys(previous.booking.customer).map(k => [k, '***'])), notes: '***', raw_message: '***', status: 'cancelled', amount: 50 } };

test('restores only masked personal fields and preserves current revision/status/amount', () => {
  const result = preserveChannexMaskedBooking('CHANNEX', incoming, previous);
  assert.deepEqual(result.booking.customer, previous.booking.customer);
  assert.equal(result.booking.notes, 'Late arrival');
  assert.equal(result.booking.raw_message, 'Original message');
  assert.equal(result.booking.status, 'cancelled');
  assert.equal(result.booking.amount, 50);
  assert.equal(result.revisionIdentity.revisionId, 'new');
  assert.equal(incoming.booking.notes, '***');
});
test('new reservations and previously masked data have null unavailable fields', () => {
  for (const prior of [undefined, incoming]) {
    const result = preserveChannexMaskedBooking('CHANNEX', incoming, prior);
    assert.equal(result.booking.notes, null);
    assert.ok(Object.values(result.booking.customer).every(v => v === null));
  }
});
test('real updates, explicit null, missing fields and other providers keep their semantics', () => {
  const update = { booking: { customer: { mail: null, phone: '+17875550999' }, notes: null } };
  const result = preserveChannexMaskedBooking('CHANNEX', update, previous);
  assert.deepEqual(result, update);
  assert.strictEqual(preserveChannexMaskedBooking('LODGIFY', incoming, previous), incoming);
  assert.equal(unmaskChannexContact(' *** '), null);
  assert.equal(unmaskChannexContact('guest@example.com'), 'guest@example.com');
});

// Execute the actual private persistence function with an isolated transaction double.
// Avoid importing the server's notification/payment clients or connecting to production.
const source = fs.readFileSync(new URL('./ingest.service.ts', import.meta.url), 'utf8');
const body = source.slice(source.indexOf('async function upsertReservation('), source.indexOf('async function ensureGuestToken('));
const upsert = vm.runInNewContext(ts.transpileModule(body + '\nglobalThis.run = upsertReservation;', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, {
  unmaskChannexContact, preserveChannexMaskedBooking,
  buildIngestKey: () => 'synthetic-key', generateReservationNumber: async () => 'TEST-1',
  PaymentState: { PAID: 'PAID', NONE: 'NONE' }, ReservationStatus: { ACTIVE: 'ACTIVE', CANCELLED: 'CANCELLED' },
  Date,
});
// runInNewContext's last assignment yields the real upsert function.
for (const mode of ['existing', 'fallback', 'new', 'cancelled'] as const) {
  test(`persistence ${mode}: masked data cannot replace contact or notes`, async () => {
    const old = { id: 'r1', guestEmail: 'guest@example.com', guestPhone: '+17875550123', externalRaw: previous, paymentState: 'NONE', externalUpdatedAt: new Date('2026-11-01') };
    let data: any;
    const tx = { reservation: {
      findUnique: async (q: any) => q.where.propertyId_externalProvider_externalId ? (mode === 'existing' || mode === 'cancelled' ? old : null) : q.where.ingestKey ? (mode === 'fallback' ? old : null) : old,
      update: async (q: any) => { data = q.data; return { ...old, ...data }; },
      create: async (q: any) => { data = q.data; return { id: 'r2', ...data }; },
    } };
    const input = { propertyId: 'p1', externalProvider: 'CHANNEX', externalId: 'b1', externalUpdatedAt: new Date('2026-11-10'), guestName: 'Synthetic Guest', guestEmail: '***', guestPhone: '***', externalRaw: incoming, checkIn: new Date(mode === 'cancelled' ? '2020-01-01' : '2099-01-01'), checkOut: new Date('2099-01-03'), status: mode === 'cancelled' ? 'CANCELLED' : 'ACTIVE', paymentState: 'NONE' };
    const result = await upsert(tx, input);
    assert.equal(result.reservation.guestEmail, mode === 'new' ? null : old.guestEmail);
    assert.equal(result.reservation.guestPhone, mode === 'new' ? null : old.guestPhone);
    assert.equal(data.externalRaw.booking.notes, mode === 'new' ? null : 'Late arrival');
    if (mode === 'existing') {
      const retry = await upsert(tx, input);
      assert.equal(retry.reservation.guestEmail, old.guestEmail);
      assert.equal(retry.reservation.externalRaw.booking.notes, 'Late arrival');
    }
  });
}
