import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { DEMO_PROPERTY_ID } from './search.js';

const benefitsSchema = z.object({ nightlyDiscountPercent: z.number().int().min(0).max(100), earlyCheckInRequest: z.boolean(), lateCheckoutRequest: z.boolean(), personalNfc: z.boolean() }).strict();
const settingsSchema = z.object({ participation: z.enum(['ACTIVE', 'PAUSED']), benefitDraft: benefitsSchema }).strict();
export const enrollmentInputSchema = settingsSchema.extend({ expectedRevision: z.number().int().min(0), confirmPilotOnly: z.literal(true) }).strict();
const recordSchema = settingsSchema.extend({ version: z.literal(1), propertyId: z.literal(DEMO_PROPERTY_ID), revision: z.number().int().min(0), updatedAt: z.string().datetime().nullable(), updatedBy: z.literal('prime-pilot-founder').nullable(), benefitsDraftOnly: z.literal(true) }).strict();
export type PilotEnrollment = z.infer<typeof recordSchema>;

export function enrollmentStore(dataDir: string) {
  const path = resolve(dataDir, 'demo-prime-enrollment.json');
  const read = (): PilotEnrollment => existsSync(path)
    ? recordSchema.parse(JSON.parse(readFileSync(path, 'utf8')))
    // Preserves the explicitly authorized Demo pilot; does not infer commercial host consent.
    : { version: 1, propertyId: DEMO_PROPERTY_ID, revision: 0, participation: 'ACTIVE', benefitDraft: { nightlyDiscountPercent: 0, earlyCheckInRequest: false, lateCheckoutRequest: false, personalNfc: false }, benefitsDraftOnly: true, updatedAt: null, updatedBy: null };
  return {
    read,
    save(input: z.infer<typeof enrollmentInputSchema>) {
      const previous = read();
      if (previous.revision !== input.expectedRevision) return { error: 'ENROLLMENT_CHANGED' as const };
      const next = recordSchema.parse({ ...previous, participation: input.participation, benefitDraft: input.benefitDraft, revision: previous.revision + 1, updatedAt: new Date().toISOString(), updatedBy: 'prime-pilot-founder' });
      const temporary = path + '.' + randomUUID() + '.tmp';
      try { writeFileSync(temporary, JSON.stringify(next), { mode: 0o600, flag: 'wx' }); renameSync(temporary, path); }
      finally { rmSync(temporary, { force: true }); }
      return { enrollment: next };
    },
  };
}
