import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { criteriaSchema, type Criteria } from './search.js';

export const tripInputSchema = z.object({ title: z.string().trim().min(1).max(80), criteria: criteriaSchema }).strict();
export const tripIdSchema = z.string().uuid();
const tripSchema = tripInputSchema.extend({ id: tripIdSchema, status: z.literal('PLANNING'), createdAt: z.string().datetime(), updatedAt: z.string().datetime() });
const fileSchema = z.object({ version: z.literal(1), member: z.literal('prime-pilot-founder'), trips: z.array(tripSchema).max(20) }).strict();
export type SavedTrip = z.infer<typeof tripSchema>;
export const hasTripDetails = (c: Criteria) => !!(c.destination || c.checkIn || c.checkOut || c.adults || c.children || c.infants || c.maxTotal || c.nfc || c.preferences.length || c.unsupported.length || c.minBedrooms != null || c.minFullBathrooms != null);

// Dedicated single-member pilot store. Never reads or writes Reservation records.
export function savedTripStore(dataDir: string) {
  const path = resolve(dataDir, 'saved-trips.json');
  const read = (): SavedTrip[] => existsSync(path) ? fileSchema.parse(JSON.parse(readFileSync(path, 'utf8'))).trips : [];
  const write = (trips: SavedTrip[]) => {
    const contents = fileSchema.parse({ version: 1, member: 'prime-pilot-founder', trips });
    const temporary = path + '.' + randomUUID() + '.tmp';
    try {
      writeFileSync(temporary, JSON.stringify(contents), { mode: 0o600, flag: 'wx' });
      renameSync(temporary, path);
    } finally { rmSync(temporary, { force: true }); }
  };
  return {
    list: read,
    save(input: z.infer<typeof tripInputSchema>, id?: string) {
      const trips = read();
      const index = id ? trips.findIndex(t => t.id === id) : -1;
      if (id && index === -1) return { error: 'TRIP_NOT_FOUND' as const };
      // Repeating an identical create after a network interruption returns the same plan.
      if (!id) {
        const existing = trips.find(t => t.title === input.title && JSON.stringify(t.criteria) === JSON.stringify(input.criteria));
        if (existing) return { trip: existing, created: false };
        if (trips.length >= 20) return { error: 'SAVED_TRIP_LIMIT' as const };
      }
      const now = new Date().toISOString();
      const trip: SavedTrip = { ...input, id: id || randomUUID(), status: 'PLANNING', createdAt: index >= 0 ? trips[index].createdAt : now, updatedAt: now };
      if (index >= 0) trips.splice(index, 1);
      write([trip, ...trips]);
      return { trip, created: !id };
    },
    remove(id: string) {
      const trips = read();
      if (!trips.some(t => t.id === id)) return false;
      write(trips.filter(t => t.id !== id));
      return true;
    },
  };
}
