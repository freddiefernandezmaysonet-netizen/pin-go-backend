import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { haasSelection, object, saveHaasInstallation, HaasAdminError } from '../services/haas-admin.service.js';

export const adminHaasRouter = Router();
adminHaasRouter.use('/api/internal/admin/haas', requireAuth, (req, res, next) => {
  const user = (req as any).user;
  if (!user?.id || user.role !== 'PLATFORM_ADMIN') return res.status(403).json({ ok: false, error: 'PLATFORM_ADMIN_REQUIRED' });
  next();
});
function fail(res: any, error: unknown) {
  if (error instanceof HaasAdminError) return res.status(error.status).json({ ok: false, error: error.message });
  if (object(error).code === 'P2034') return res.status(409).json({ ok: false, error: 'HAAS_CONCURRENT_UPDATE' });
  console.error('[ADMIN_HAAS]', error);
  return res.status(500).json({ ok: false, error: 'HAAS_UNAVAILABLE' });
}
const customerSelect = { id: true, email: true, fullName: true, phone: true, organizationName: true,
  organizationId: true, requestedLocks: true, status: true, completedAt: true, createdAt: true, updatedAt: true,
  metadata: true, stripeSubscriptionId: true } as const;
const lockSelect = { id: true, displayName: true, ttlockLockName: true, isActive: true,
  property: { select: { id: true, name: true, organizationId: true } },
  deviceHealth: { select: { battery: true, batteryLastSuccessfulAt: true, batteryProviderResponseAt: true,
    gatewayConnected: true, isOnline: true, lastSyncAt: true, healthStatus: true } } } as const;

adminHaasRouter.get('/api/internal/admin/haas', async (req, res) => {
  try {
    const q = String(req.query.q ?? '').trim().slice(0, 100), cursor = String(req.query.cursor ?? '');
    // Match stored readings and their owning organization before paginating contracts.
    const lowBatteryLocks = req.query.battery === 'low' ? await prisma.lock.findMany({
      where: { deviceHealth: { is: { battery: { gte: 0, lte: 30 } } } },
      select: { id: true, property: { select: { organizationId: true } } },
    }) : null;
    const rows = await prisma.pendingSignup.findMany({ where: { status: 'COMPLETED', organizationId: { not: null },
      metadata: { path: ['haasSelection', 'plan'], equals: 'haas' },
      ...(lowBatteryLocks ? { AND: [{ OR: lowBatteryLocks.map(lock => ({
        organizationId: lock.property.organizationId,
        metadata: { path: ['haasInstallation', 'lockId'], equals: lock.id },
      })) }] } : {}),
      ...(q ? { OR: ['organizationName', 'fullName', 'email'].map(field => ({ [field]: { contains: q, mode: 'insensitive' as const } })) } : {}) },
      select: customerSelect, orderBy: { id: 'desc' }, take: 41, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) });
    const items = await Promise.all(rows.slice(0,40).map(async row => {
      const meta = object(row.metadata), installation = object(meta.haasInstallation), selection = haasSelection(meta);
      const lock = installation.lockId ? await prisma.lock.findFirst({ where: { id: String(installation.lockId),
        property: { organizationId: row.organizationId! } }, select: lockSelect }) : null;
      const { metadata, ...customer } = row;
      return { ...customer, selection, payment: object(meta.haasPayment), installation: {
        status: installation.status ?? 'PENDING', lockId: lock?.id ?? null,
        scheduledAt: installation.scheduledAt ?? null, notes: installation.notes ?? '',
        installationAddress: installation.installationAddress ?? '', serialNumber: installation.serialNumber ?? '' }, lock };
    }));
    res.json({ ok: true, items, nextCursor: rows.length > 40 ? rows[39]!.id : null });
  } catch(error) { fail(res,error); }
});
adminHaasRouter.get('/api/internal/admin/haas/:id/locks', async (req, res) => {
  try {
    const row = await prisma.pendingSignup.findUnique({ where: { id: req.params.id }, select: customerSelect });
    if (!row || row.status !== 'COMPLETED' || !row.organizationId || !haasSelection(row.metadata)) throw new HaasAdminError(404,'CONTRACT_NOT_FOUND');
    const items = await prisma.lock.findMany({ where: { isActive: true, property: { organizationId: row.organizationId } },
      select: { id: true, displayName: true, ttlockLockName: true, property: { select: { name: true } } }, orderBy: { id: 'asc' } });
    res.json({ ok: true, items });
  } catch(error) { fail(res,error); }
});
adminHaasRouter.patch('/api/internal/admin/haas/:id/installation', async (req, res) => {
  try {
    const b = object(req.body);
    await saveHaasInstallation(prisma, req.params.id!, { expectedUpdatedAt: String(b.expectedUpdatedAt ?? ''),
      status: String(b.status ?? ''), lockId: b.lockId ? String(b.lockId) : null,
      scheduledAt: b.scheduledAt ? String(b.scheduledAt) : null, notes: String(b.notes ?? ''),
      ...(b.installationAddress !== undefined ? { installationAddress: String(b.installationAddress) } : {}),
      ...(b.serialNumber !== undefined ? { serialNumber: String(b.serialNumber) } : {}) }, (req as any).user.id);
    res.json({ ok: true });
  } catch(error) { fail(res,error); }
});
