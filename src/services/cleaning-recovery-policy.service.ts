import type { PrismaClient } from "@prisma/client";

export class CleaningRecoveryPolicyError extends Error {
  constructor(public code: string, public status = 409) { super(code); }
}
export const DEFAULT_CLEANING_RECOVERY_POLICY = Object.freeze({ revision: 0, maxDelayMinutes: 30, maxAccessExtensionMinutes: 0, arrivalSafetyMarginMinutes: 0 });
export function parseCleaningRecoveryPolicy(raw: any) {
  const limits = { revision: Number.MAX_SAFE_INTEGER, maxDelayMinutes: 240, maxAccessExtensionMinutes: 240, arrivalSafetyMarginMinutes: 120 };
  for (const [key, max] of Object.entries(limits)) {
    if (!Number.isSafeInteger(raw?.[key]) || raw[key] < 0 || raw[key] > max) throw new CleaningRecoveryPolicyError("CLEANING_RECOVERY_POLICY_INVALID", 400);
  }
  return { revision: raw.revision as number, maxDelayMinutes: raw.maxDelayMinutes as number, maxAccessExtensionMinutes: raw.maxAccessExtensionMinutes as number, arrivalSafetyMarginMinutes: raw.arrivalSafetyMarginMinutes as number };
}
type Scope = { propertyId: string; organizationId: string };
export async function readCleaningRecoveryPolicy(db: PrismaClient, scope: Scope) {
  const property = await db.property.findFirst({ where: { id: scope.propertyId, organizationId: scope.organizationId }, select: { id: true } });
  if (!property) throw new CleaningRecoveryPolicyError("PROPERTY_NOT_FOUND", 404);
  return await db.cleaningRecoveryPolicy.findUnique({ where: { propertyId: scope.propertyId } }) ?? { ...DEFAULT_CLEANING_RECOVERY_POLICY };
}
export async function saveCleaningRecoveryPolicy(db: PrismaClient, scope: Scope & { userId: string }, raw: unknown) {
  const policy = parseCleaningRecoveryPolicy(raw);
  return db.$transaction(async tx => {
    await tx.$queryRaw`SELECT "id" FROM "Property" WHERE "id" = ${scope.propertyId} FOR UPDATE`;
    const property = await tx.property.findFirst({ where: { id: scope.propertyId, organizationId: scope.organizationId }, select: { id: true } });
    if (!property) throw new CleaningRecoveryPolicyError("PROPERTY_NOT_FOUND", 404);
    const previous = await tx.cleaningRecoveryPolicy.findUnique({ where: { propertyId: scope.propertyId } });
    if ((previous?.revision ?? 0) !== policy.revision) throw new CleaningRecoveryPolicyError("CLEANING_RECOVERY_POLICY_CONFLICT");
    return tx.cleaningRecoveryPolicy.upsert({ where: { propertyId: scope.propertyId },
      create: { ...policy, revision: 1, propertyId: scope.propertyId, updatedByUserId: scope.userId },
      update: { ...policy, revision: policy.revision + 1, updatedByUserId: scope.userId },
    });
  });
}
