import { PrismaClient } from '@prisma/client';
import { fromZonedTime } from 'date-fns-tz';
import { checkPropertyAvailability } from '../src/services/availability.service.js';
import { calculateDirectBookingPricing } from '../src/services/direct-booking-pricing.service.js';
import { DEMO_PROPERTY_ID, type CatalogProperty, type Criteria } from './search.js';

const prisma = new PrismaClient();
async function source() {
  return prisma.property.findFirst({ where: { id: DEMO_PROPERTY_ID, isTestProperty: true, status: 'ACTIVE' }, select: {
    id: true, name: true, publicTitle: true, publicPhotos: true, isTestProperty: true, status: true,
    city: true, region: true, country: true, maxGuests: true, minimumNights: true, maximumNights: true,
    checkInTime: true, checkOutTime: true, timezone: true,
    listingDetails: { select: { childrenPolicy: true, infantsPolicy: true, adultsOnly: true, petsPolicy: true,
      minimumPrimaryBookingGuestAge: true, parkingAvailability: true, stepFreeEntrance: true, stepFreeBedroomAccess: true,
      stepFreeBathroomAccess: true, features: { where: { isActive: true }, select: { type: true } }, sharedSpaces: { select: { type: true } } } },
    amenities: { where: { isActive: true, chargeMode: { in: ['INCLUDED', 'REQUIRED'] } }, select: { name: true } },
    locks: { where: { ttlockLockId: 29944630, isActive: true }, select: { id: true } },
  } });
}
function photos(value: unknown): string[] {
  let raw = value;
  if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch { return []; } }
  return (Array.isArray(raw) ? raw : []).flatMap(x => {
    const u = typeof x === 'string' ? x : x && typeof x === 'object' && 'url' in x ? String(x.url) : '';
    try { return new URL(u).protocol === 'https:' ? [u] : []; } catch { return []; }
  }).slice(0, 6);
}
export async function catalog(): Promise<CatalogProperty[]> {
  const p = await source(); if (!p) return [];
  const details = p.listingDetails;
  const amenities = p.amenities.map(a => a.name.toLowerCase().trim());
  const features: string[] = [];
  if (amenities.some(a => ['pool', 'piscina', 'private pool', 'piscina privada'].includes(a)) || details?.sharedSpaces.some(s => s.type === 'POOL')) features.push('pool');
  if (amenities.some(a => ['private pool', 'piscina privada'].includes(a))) features.push('private_pool');
  if (amenities.some(a => ['wifi', 'wi-fi', 'internet'].includes(a))) features.push('wifi');
  if (details?.parkingAvailability === 'YES') features.push('parking');
  if (details?.features.some(f => f.type === 'BEACH_ACCESS')) features.push('beach_access');
  if (details?.petsPolicy === 'ALLOWED') features.push('pets_allowed');
  if ([details?.stepFreeEntrance, details?.stepFreeBedroomAccess, details?.stepFreeBathroomAccess].every(x => x === 'YES')) features.push('step_free');
  return [{ id: p.id, isTestProperty: p.isTestProperty, status: p.status, name: p.publicTitle || p.name,
    location: [p.city, p.region, p.country].filter(Boolean).join(', '),
    destinationTerms: [p.city, p.region, p.country, p.name, 'Demo', 'Puerto Rico', 'PR'].filter((x): x is string => !!x),
    maxGuests: p.maxGuests, minimumNights: p.minimumNights, maximumNights: p.maximumNights,
    photos: photos(p.publicPhotos), features,
    childrenAllowed: details?.childrenPolicy === 'ALLOWED' && details?.adultsOnly !== 'YES',
    infantsAllowed: details?.infantsPolicy === 'ALLOWED' && details?.adultsOnly !== 'YES',
    minimumAge: details?.minimumPrimaryBookingGuestAge ?? null,
    nfcVerified: p.locks.length > 0,
  }];
}
async function stay(c: Criteria) {
  const p = await source(); if (!p) throw new Error('CATALOG_UNAVAILABLE');
  if (!p.timezone) throw new Error('PROPERTY_TIMEZONE_REQUIRED');
  return { propertyId: p.id,
    checkIn: fromZonedTime(`${c.checkIn}T${p.checkInTime || '16:00'}:00`, p.timezone),
    checkOut: fromZonedTime(`${c.checkOut}T${p.checkOutTime || '11:00'}:00`, p.timezone),
  };
}
export async function available(_p: CatalogProperty, c: Criteria) { return (await checkPropertyAvailability(await stay(c))).available; }
export async function quote(_p: CatalogProperty, c: Criteria) {
  const value = await calculateDirectBookingPricing({ ...await stay(c), selectedAmenityIds: [], includeAuditEntries: false });
  // Deliberately return only the public price fields; never revenue audit details or conflicts.
  return { currency: value.currency, nights: value.nights, nightlySubtotal: value.nightlySubtotal,
    cleaningFee: value.cleaningFee, amenitiesTotal: value.amenitiesTotal, taxesTotal: value.taxesTotal,
    totalAmount: value.totalAmount, totalAmountCents: value.totalAmountCents };
}
