import test from 'node:test';
import assert from 'node:assert/strict';
import { listingFacts } from './property-facts.js';

const pool = { name: 'Piscina privada', isActive: true, chargeMode: 'INCLUDED' };
test('private pool needs explicit included evidence and is not inferred from entire-place lodging', () => {
  assert.deepEqual(listingFacts({ accommodationType: 'ENTIRE_PLACE', sharedSpaces: [{ type: 'POOL' }] }, []).features, ['pool', 'entire_place']);
  assert.equal(listingFacts(null, [pool]).details.poolPrivacy, 'PRIVATE');
  const ambiguous = listingFacts({ sharedSpaces: [{ type: 'POOL' }] }, [pool]);
  assert.equal(ambiguous.details.poolPrivacy, 'UNCONFIRMED'); assert.equal(ambiguous.features.includes('private_pool'), false);
  assert.equal(listingFacts(null, [{ ...pool, chargeMode: 'OPTIONAL' }]).features.includes('pool'), false);
  assert.equal(listingFacts(null, [{ ...pool, isActive: false }]).features.includes('private_pool'), false);
});
test('views, beach access, whole lodging and included features remain independent', () => {
  const facts = listingFacts({ features: [{ type: 'OCEAN_VIEW' }, { type: 'WORKSPACE' }, { type: 'GYM', isActive: false }], parkingAvailability: 'YES', parkingFeeType: 'PAID' }, []);
  assert.deepEqual(facts.features, ['parking', 'ocean_view', 'workspace']);
  assert.equal(facts.features.includes('beach_access'), false);
  assert.equal(facts.features.includes('waterfront'), false);
  assert.equal(facts.features.includes('entire_place'), false);
  assert.equal(facts.details.parkingFeeType, 'PAID');
});
test('bedrooms, beds and bathrooms preserve missing and zero values without substitutions', () => {
  const facts = listingFacts({ bedroomCount: 0, fullBathroomCount: null, halfBathroomCount: 2, sleepingAreas: [{ beds: [{ type: 'SOFA_BED', quantity: 1 }, { type: 'QUEEN', quantity: 2 }] }] }, []);
  assert.equal(facts.details.bedrooms, 0); assert.equal(facts.details.fullBathrooms, null); assert.equal(facts.details.halfBathrooms, 2);
  assert.deepEqual(facts.details.beds, [{ type: 'SOFA_BED', quantity: 1 }, { type: 'QUEEN', quantity: 2 }]);
  assert.equal(listingFacts(null, []).details.bedrooms, null);
});
test('nearby host reports are bounded, active-only and never treated as verified walking times', () => {
  const beach = { name: 'Example beach', nameEs: 'Playa de ejemplo', category: 'BEACH', distanceText: '1 km', travelTimeMinutes: 5, isActive: true };
  const facts = listingFacts(null, [], [beach, { ...beach, isActive: false }]);
  assert.equal(facts.details.hostReportedNearbyPlaces.length, 1);
  assert.equal(facts.details.hostReportedNearbyPlaces[0].travelMode, 'UNSPECIFIED');
  assert.equal(facts.details.hostReportedNearbyPlaces[0].independentlyVerified, false);
  assert.deepEqual(facts.features, []);
  assert.equal(listingFacts(null, [], [{ ...beach, travelTimeMinutes: -1 }]).details.hostReportedNearbyPlaces[0].travelTimeMinutes, null);
  assert.equal(listingFacts(null, [], Array(10).fill(beach)).details.hostReportedNearbyPlaces.length, 5);
});
