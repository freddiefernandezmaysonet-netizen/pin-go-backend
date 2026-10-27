import test from 'node:test';
import assert from 'node:assert/strict';
import { criteriaSchema, DEMO_PROPERTY_ID, emptyCriteria, matches, searchCatalog, validateStay, type CatalogProperty } from './search.js';
const criteria = { ...emptyCriteria, destination: 'Puerto Rico', checkIn: '2026-11-06', checkOut: '2026-11-09', adults: 2 };
const property: CatalogProperty = { id: DEMO_PROPERTY_ID, isTestProperty: true, status: 'ACTIVE', name: 'Demo', location: 'PR', destinationTerms: ['Puerto Rico'], maxGuests: 4, minimumNights: 1, maximumNights: 30, photos: [], features: ['wifi'], childrenAllowed: false, infantsAllowed: false, nfcVerified: true, minimumAge: 21 };
const quote = { currency: 'usd', nights: 3, nightlySubtotal: 300, cleaningFee: 40, amenitiesTotal: 10, taxesTotal: 35, totalAmount: 385, totalAmountCents: 38500 };
test('strict criteria reject arbitrary instructions, invalid dates, and impossible party sizes', () => {
  assert.equal(criteriaSchema.safeParse({ ...criteria, sql: 'select *' }).success, false);
  assert.equal(criteriaSchema.safeParse({ ...criteria, checkIn: '2026-02-30' }).success, false);
  assert.equal(criteriaSchema.safeParse({ ...criteria, adults: 0 }).success, false);
  assert.deepEqual(validateStay({ ...criteria, checkOut: criteria.checkIn }, '2026-10-27'), ['dates']);
  assert.deepEqual(validateStay(criteria, '2027-01-01'), ['past']);
});
test('commercial, inactive, and non-allowlisted properties cannot enter Prime pilot', () => {
  assert.equal(matches(property, criteria), true);
  for (const p of [{ ...property, isTestProperty: false }, { ...property, id: 'other' }, { ...property, status: 'INACTIVE' }]) assert.equal(matches(p, criteria), false);
});
test('destination, occupancy, child rules, unsupported requests, NFC and preferences fail closed', () => {
  for (const c of [{ ...criteria, destination: 'Miami' }, { ...criteria, adults: 5 }, { ...criteria, children: 1 }, { ...criteria, infants: 1 }, { ...criteria, preferences: ['private_pool'] as typeof criteria.preferences }, { ...criteria, unsupported: ['sea view'] }]) assert.equal(matches(property, c), false);
  assert.equal(matches({ ...property, nfcVerified: false }, { ...criteria, nfc: true }), false);
  assert.equal(matches({ ...property, maxGuests: null }, criteria), false);
});
test('unavailable properties are excluded before quoting', async () => {
  let calls = 0;
  const result = await searchCatalog(criteria, { catalog: async () => [property], available: async () => false, quote: async () => { calls++; return quote; } });
  assert.equal(result.results.length, 0); assert.equal(calls, 0);
});
test('budget uses the real full quote, including mandatory fees and taxes', async () => {
  const deps = { catalog: async () => [property], available: async () => true, quote: async () => quote };
  assert.equal((await searchCatalog({ ...criteria, maxTotal: 350 }, deps)).results.length, 0);
  const result = await searchCatalog({ ...criteria, maxTotal: 385 }, deps);
  assert.equal(result.results.length, 1); assert.deepEqual(result.results[0].quote, quote);
});
test('upstream failures and invalid price data never become available results', async () => {
  const deps = { catalog: async () => [property], available: async () => true, quote: async () => quote };
  const failed = await searchCatalog(criteria, { ...deps, available: async () => { throw new Error('offline'); } });
  assert.equal(failed.results.length, 0); assert.equal(failed.failed, 1);
  assert.equal((await searchCatalog(criteria, { ...deps, quote: async () => ({ ...quote, currency: 'eur' }) })).failed, 1);
  assert.equal((await searchCatalog(criteria, { ...deps, quote: async () => ({ ...quote, totalAmountCents: 1 }) })).failed, 1);
});
test('no-match diagnostics distinguish unverified preferences, unavailable dates and budget', async () => {
  let availabilityCalls = 0;
  const deps = { catalog: async () => [property, { ...property, id: 'production-property', name: 'Private listing' }], available: async () => { availabilityCalls++; return true; }, quote: async () => quote };
  const required = { ...criteria, preferences: ['private_pool'] as typeof criteria.preferences, unsupported: ['a 5 minutos de la playa'] };
  const unverified = await searchCatalog(required, deps);
  assert.equal(unverified.diagnostics.catalogCount, 1);
  assert.deepEqual(unverified.diagnostics.excludedBy, { 'unverified:private_pool': 1, unsupported_requirements: 1 });
  assert.equal(availabilityCalls, 0);
  assert.deepEqual(required.unsupported, ['a 5 minutos de la playa']);
  const budget = await searchCatalog({ ...criteria, maxTotal: 350 }, deps);
  assert.equal(budget.diagnostics.overBudget, 1); assert.equal(budget.diagnostics.unavailable, 0);
  const unavailable = await searchCatalog(criteria, { ...deps, available: async () => false });
  assert.equal(unavailable.diagnostics.unavailable, 1); assert.equal(unavailable.diagnostics.overBudget, 0);
});
