// Public listing evidence only. No guest, host account, access or reservation data.
export const preferenceNames = {
  pool: ['Piscina', 'Pool'], private_pool: ['Piscina privada', 'Private pool'], wifi: ['Wi-Fi', 'Wi-Fi'],
  parking: ['Estacionamiento', 'Parking'], beach_access: ['Acceso a playa', 'Beach access'],
  pets_allowed: ['Mascotas', 'Pets allowed'], step_free: ['Acceso sin escalones', 'Step-free access'],
  ocean_view: ['Vista al mar', 'Ocean view'], mountain_view: ['Vista a la montaña', 'Mountain view'],
  waterfront: ['Frente al agua', 'Waterfront'], pool_table: ['Mesa de billar', 'Pool table'],
  gym: ['Gimnasio', 'Gym'], fireplace: ['Chimenea', 'Fireplace'], outdoor_grill: ['Parrilla', 'Outdoor grill'],
  workspace: ['Espacio de trabajo', 'Workspace'], hot_tub: ['Jacuzzi', 'Hot tub'],
  kitchen: ['Cocina', 'Kitchen'], air_conditioning: ['Aire acondicionado', 'Air conditioning'],
  entire_place: ['Alojamiento completo', 'Entire place'],
} as const;
export type Preference = keyof typeof preferenceNames;
const structuredFeatures: Record<string, Preference> = { BEACH_ACCESS: 'beach_access', OCEAN_VIEW: 'ocean_view', MOUNTAIN_VIEW: 'mountain_view', WATERFRONT: 'waterfront', POOL_TABLE: 'pool_table', GYM: 'gym', FIREPLACE: 'fireplace', OUTDOOR_GRILL: 'outdoor_grill', WORKSPACE: 'workspace' };
type ListingEvidence = {
  accommodationType?: string | null; propertyType?: string | null;
  bedroomCount?: number | null; fullBathroomCount?: number | null; halfBathroomCount?: number | null;
  parkingAvailability?: string; parkingFeeType?: string | null; petsPolicy?: string;
  stepFreeEntrance?: string; stepFreeBedroomAccess?: string; stepFreeBathroomAccess?: string;
  features?: { type: string; isActive?: boolean }[];
  sharedSpaces?: { type: string }[];
  sleepingAreas?: { beds: { type: string; quantity: number }[] }[];
};
type AmenityEvidence = { name: string; isActive: boolean; chargeMode: string };
type NearbyEvidence = { name: string; nameEs: string | null; category: string; distanceText: string | null; travelTimeMinutes: number | null; isActive: boolean };
const count = (value: number | null | undefined) => value !== null && value !== undefined && Number.isInteger(value) && value >= 0 && value <= 100 ? value : null;
export function listingFacts(details: ListingEvidence | null, amenities: AmenityEvidence[], nearbyPlaces: NearbyEvidence[] = []) {
  const included = amenities.filter(a => a.isActive && ['INCLUDED', 'REQUIRED'].includes(a.chargeMode)).map(a => a.name.toLowerCase().trim());
  const has = (...names: string[]) => included.some(a => names.includes(a));
  const shared = new Set((details?.sharedSpaces || []).map(s => s.type));
  const features = new Set<Preference>();
  const explicitPrivatePool = has('private pool', 'piscina privada');
  if (has('pool', 'piscina') || explicitPrivatePool || shared.has('POOL')) features.add('pool');
  // Mixed private/shared evidence needs clarification about which pool belongs to the stay.
  if (explicitPrivatePool && !shared.has('POOL')) features.add('private_pool');
  if (has('wifi', 'wi-fi', 'internet')) features.add('wifi');
  if (has('hot tub', 'jacuzzi', 'hidromasaje') || shared.has('HOT_TUB')) features.add('hot_tub');
  if (has('kitchen', 'cocina') || shared.has('KITCHEN')) features.add('kitchen');
  if (has('air conditioning', 'aire acondicionado', 'a/c', 'ac')) features.add('air_conditioning');
  if (details?.parkingAvailability === 'YES') features.add('parking');
  if (details?.petsPolicy === 'ALLOWED') features.add('pets_allowed');
  if ([details?.stepFreeEntrance, details?.stepFreeBedroomAccess, details?.stepFreeBathroomAccess].every(x => x === 'YES')) features.add('step_free');
  if (details?.accommodationType === 'ENTIRE_PLACE') features.add('entire_place');
  for (const feature of details?.features || []) if (feature.isActive !== false && structuredFeatures[feature.type]) features.add(structuredFeatures[feature.type]);
  const beds = new Map<string, number>();
  for (const area of details?.sleepingAreas || []) for (const bed of area.beds) {
    if (Number.isInteger(bed.quantity) && bed.quantity > 0 && bed.quantity <= 20) beds.set(bed.type, (beds.get(bed.type) || 0) + bed.quantity);
  }
  return {
    features: [...features],
    details: {
      source: 'HOST_LISTING' as const,
      accommodationType: details?.accommodationType || null, propertyType: details?.propertyType || null,
      bedrooms: count(details?.bedroomCount), fullBathrooms: count(details?.fullBathroomCount), halfBathrooms: count(details?.halfBathroomCount),
      beds: [...beds].map(([type, quantity]) => ({ type, quantity })),
      poolPrivacy: explicitPrivatePool && shared.has('POOL') ? 'UNCONFIRMED' : explicitPrivatePool ? 'PRIVATE' : shared.has('POOL') ? 'SHARED' : 'UNCONFIRMED',
      sharedSpaces: [...shared], parkingFeeType: details?.parkingAvailability === 'YES' ? details.parkingFeeType || 'UNKNOWN' : 'UNKNOWN',
      hostReportedNearbyPlaces: nearbyPlaces.filter(p => p.isActive).slice(0, 5).map(p => ({
        name: p.name.slice(0, 200), nameEs: p.nameEs?.slice(0, 200) || null, category: p.category,
        distanceText: p.distanceText?.slice(0, 120) || null,
        travelTimeMinutes: p.travelTimeMinutes !== null && Number.isInteger(p.travelTimeMinutes) && p.travelTimeMinutes >= 0 && p.travelTimeMinutes <= 1440 ? p.travelTimeMinutes : null,
        travelMode: 'UNSPECIFIED' as const, independentlyVerified: false as const,
      })),
    },
  };
}
export type PropertyFacts = ReturnType<typeof listingFacts>['details'];
