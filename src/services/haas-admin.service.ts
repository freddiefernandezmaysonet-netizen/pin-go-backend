import type { PrismaClient, Prisma } from '@prisma/client';

export function object(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
}
export function haasSelection(metadata: unknown) {
  const meta = object(metadata), selection = object(meta.haasSelection);
  if (selection.plan !== 'haas' || !['essential', 'pro', 'elite'].includes(selection.lock)) return null;
  const term = Number(selection.termMonths);
  return { model: selection.lock as string, termMonths: [12, 24].includes(term) ? term :
    String(meta.contractOption).startsWith('contract_24_') ? 24 : null };
}
export class HaasAdminError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

// Called only from the verified Stripe webhook. Never infer payment from a browser redirect.
export async function recordHaasPayment(db: PrismaClient, session: {
  id: string; payment_status: string; metadata?: Record<string, string> | null;
  amount_total: number | null; currency: string | null;
}, recordedAt: Date) {
  const id = session.metadata?.pendingSignupId;
  if (!id || session.payment_status !== 'paid') return;
  const row = await db.pendingSignup.findUnique({ where: { id } });
  if (!row || row.stripeCheckoutSessionId !== session.id || !haasSelection(row.metadata)) return;
  const meta = object(row.metadata);
  if (object(meta.haasPayment).sessionId === session.id) return;
  const result = await db.pendingSignup.updateMany({ where: { id, updatedAt: row.updatedAt }, data: {
    metadata: { ...meta, haasPayment: { sessionId: session.id, status: 'paid',
      amountPaidCents: session.amount_total, currency: session.currency,
      recordedAt: recordedAt.toISOString() } } as Prisma.InputJsonValue,
  } });
  if (result.count !== 1) throw new HaasAdminError(409, 'HAAS_CONCURRENT_UPDATE');
}

export async function saveHaasInstallation(db: PrismaClient, id: string, input: {
  expectedUpdatedAt: string; status: string; lockId: string | null; scheduledAt: string | null; notes: string;
}, adminId: string) {
  if (!['PENDING', 'SCHEDULED', 'COMPLETED'].includes(input.status) || input.notes.length > 2000 ||
    !Number.isFinite(Date.parse(input.expectedUpdatedAt)) ||
    (input.scheduledAt !== null && !Number.isFinite(Date.parse(input.scheduledAt)))) {
    throw new HaasAdminError(400, 'INVALID_INSTALLATION');
  }
  return db.$transaction(async tx => {
    const row = await tx.pendingSignup.findUnique({ where: { id } });
    if (!row || row.status !== 'COMPLETED' || !row.organizationId || !haasSelection(row.metadata))
      throw new HaasAdminError(404, 'CONTRACT_NOT_FOUND');
    const meta = object(row.metadata);
    if (object(meta.haasPayment).status !== 'paid') throw new HaasAdminError(409, 'PAYMENT_NOT_CONFIRMED');
    if (row.updatedAt.toISOString() !== input.expectedUpdatedAt) throw new HaasAdminError(409, 'HAAS_CONCURRENT_UPDATE');
    if (input.lockId) {
      const lock = await tx.lock.findFirst({ where: { id: input.lockId, isActive: true,
        property: { organizationId: row.organizationId } }, select: { id: true } });
      if (!lock) throw new HaasAdminError(400, 'LOCK_NOT_IN_CUSTOMER_ORGANIZATION');
    }
    if (input.lockId) {
      const other = await tx.pendingSignup.findFirst({ where: { id: { not: id }, status: 'COMPLETED',
        metadata: { path: ['haasInstallation', 'lockId'], equals: input.lockId } }, select: { id: true } });
      if (other) throw new HaasAdminError(409, 'LOCK_ALREADY_ASSIGNED');
    }
    if (input.status === 'COMPLETED' && !input.lockId) throw new HaasAdminError(400, 'INSTALLED_LOCK_REQUIRED');
    if (input.status === 'SCHEDULED' && !input.scheduledAt) throw new HaasAdminError(400, 'INSTALLATION_DATE_REQUIRED');
    const result = await tx.pendingSignup.updateMany({ where: { id, updatedAt: row.updatedAt }, data: {
      metadata: { ...meta, haasInstallation: { ...input, updatedBy: adminId, updatedAt: new Date().toISOString() } } as Prisma.InputJsonValue,
    } });
    if (result.count !== 1) throw new HaasAdminError(409, 'HAAS_CONCURRENT_UPDATE');
  }, { isolationLevel: 'Serializable' });
}
