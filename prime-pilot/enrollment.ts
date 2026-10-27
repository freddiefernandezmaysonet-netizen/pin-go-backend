import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { DEMO_PROPERTY_ID } from './search.js';
import { PRIME_MIN_NIGHTLY_DISCOUNT, PRIME_MAX_NIGHTLY_DISCOUNT } from './enrollment-policy.js';

const benefitFlags = { earlyCheckInRequest: z.boolean(), lateCheckoutRequest: z.boolean(), personalNfc: z.boolean() };
const legacyBenefitsSchema = z.object({ nightlyDiscountPercent: z.number().int().min(0).max(100), ...benefitFlags }).strict();
const benefitsSchema = z.object({ nightlyDiscountPercent: z.number().min(PRIME_MIN_NIGHTLY_DISCOUNT).max(PRIME_MAX_NIGHTLY_DISCOUNT).nullable(), ...benefitFlags }).strict();
const settingsSchema = z.object({ participation: z.enum(['ACTIVE', 'PAUSED']), benefitDraft: benefitsSchema }).strict();
const hasRequiredDiscount = (settings: z.infer<typeof settingsSchema>) => settings.participation === 'PAUSED' || settings.benefitDraft.nightlyDiscountPercent !== null;
const requiredDiscountIssue = { message: 'Active participation requires a 5–20% nightly discount', path: ['benefitDraft', 'nightlyDiscountPercent'] };
export const enrollmentInputSchema = settingsSchema.extend({ expectedRevision: z.number().int().min(0), confirmPilotOnly: z.literal(true) }).strict().refine(hasRequiredDiscount, requiredDiscountIssue);
const metadata = { propertyId: z.literal(DEMO_PROPERTY_ID), revision: z.number().int().min(0), updatedAt: z.string().datetime().nullable(), updatedBy: z.literal('prime-pilot-founder').nullable(), benefitsDraftOnly: z.literal(true) };
const recordSchema = settingsSchema.extend({ version: z.literal(2), ...metadata }).strict().refine(hasRequiredDiscount, requiredDiscountIssue);
const legacyRecordSchema = z.object({ version: z.literal(1), participation: z.enum(['ACTIVE', 'PAUSED']), benefitDraft: legacyBenefitsSchema, ...metadata }).strict();
const storedRecordSchema = z.union([recordSchema, legacyRecordSchema]);
export type PilotEnrollment = z.infer<typeof storedRecordSchema>;

export function enrollmentStore(dataDir: string) {
  const path = resolve(dataDir, 'demo-prime-enrollment.json');
  const read = (): PilotEnrollment => existsSync(path)
    ? storedRecordSchema.parse(JSON.parse(readFileSync(path, 'utf8')))
    // Preserves the explicitly authorized Demo pilot; does not infer commercial host consent.
    : { version: 1, propertyId: DEMO_PROPERTY_ID, revision: 0, participation: 'ACTIVE', benefitDraft: { nightlyDiscountPercent: 0, earlyCheckInRequest: false, lateCheckoutRequest: false, personalNfc: false }, benefitsDraftOnly: true, updatedAt: null, updatedBy: null };
  return {
    read,
    save(input: z.infer<typeof enrollmentInputSchema>) {
      // Validate at the persistence boundary too; only explicit valid saves upgrade v1 records.
      const validated = enrollmentInputSchema.parse(input);
      const previous = read();
      if (previous.revision !== validated.expectedRevision) return { error: 'ENROLLMENT_CHANGED' as const };
      const next = recordSchema.parse({ ...previous, version: 2, participation: validated.participation, benefitDraft: validated.benefitDraft, revision: previous.revision + 1, updatedAt: new Date().toISOString(), updatedBy: 'prime-pilot-founder' });
      const temporary = path + '.' + randomUUID() + '.tmp';
      try { writeFileSync(temporary, JSON.stringify(next), { mode: 0o600, flag: 'wx' }); renameSync(temporary, path); }
      finally { rmSync(temporary, { force: true }); }
      return { enrollment: next };
    },
  };
}
