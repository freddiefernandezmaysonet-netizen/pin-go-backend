import { Router } from "express";
import { PrismaClient } from "@prisma/client";
import { assertLockCapacity } from "../services/lockCapacity.service";

export function buildAdminLocksSwapRouter(prisma: PrismaClient) {
  const router = Router();

  /**
   * Admin key middleware
   * Requiere header: x-admin-key: <ADMIN_KEY>
   */
  router.use((req, res, next) => {
    const key = req.header("x-admin-key");
    const expected = process.env.ADMIN_KEY;

    if (!expected) {
      return res.status(500).json({ ok: false, error: "ADMIN_KEY not configured" });
    }
    if (!key || key !== expected) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }
    next();
  });

  /**
   * POST /api/admin/locks/swap
   * Body: { propertyId, oldTtlockLockId, newTtlockLockId, newTtlockLockName? }
   *
   * Reemplaza 1 lock activo por otro (1:1) sin aumentar el uso neto.
   */
  router.post("/locks/swap", async (req, res) => {
    try {
      const { propertyId, oldTtlockLockId, newTtlockLockId, newTtlockLockName } = req.body ?? {};

      if (!propertyId || !oldTtlockLockId || !newTtlockLockId) {
        return res.status(400).json({
          ok: false,
          error: "Missing propertyId, oldTtlockLockId, newTtlockLockId",
        });
      }

      if (Number(oldTtlockLockId) === Number(newTtlockLockId)) {
        return res.status(400).json({ ok: false, error: "oldTtlockLockId cannot equal newTtlockLockId" });
      }

      // 1) Cargar property + orgId
      const property = await prisma.property.findUnique({
        where: { id: String(propertyId) },
        select: { id: true, organizationId: true },
      });
      if (!property) return res.status(404).json({ ok: false, error: "Property not found" });

      const orgId = property.organizationId;

      // 2) Validar que el lock viejo existe, está activo, y pertenece a esa property
      const oldLock = await prisma.lock.findUnique({
        where: { ttlockLockId: Number(oldTtlockLockId) },
        select: { id: true, ttlockLockId: true, propertyId: true, isActive: true },
      });

      if (!oldLock) return res.status(404).json({ ok: false, error: "Old lock not found" });
      if (oldLock.propertyId !== property.id) {
        return res.status(400).json({ ok: false, error: "Old lock does not belong to this property" });
      }
      if (!oldLock.isActive) {
        return res.status(400).json({ ok: false, error: "Old lock is not active (cannot swap)" });
      }

      // 3) Capacity check sin aumento neto (add=0)
      //    Esto garantiza que la org tenga suscripción válida.
      const cap = await assertLockCapacity(prisma, String(orgId), 0);
      if (!cap.ok) {
        return res.status(403).json({
          ok: false,
          error: cap.code, // LOCK_LIMIT_REACHED (o lo que sea)
          entitledLocks: cap.entitled,
          usedLocks: cap.used,
        });
      }

      // 4) Transacción: desactivar viejo + upsert nuevo como activo
      const result = await prisma.$transaction(async (tx) => {
        const deactivated = await tx.lock.update({
          where: { id: oldLock.id },
          data: { isActive: false },
        });

        const newLock = await tx.lock.upsert({
          where: { ttlockLockId: Number(newTtlockLockId) },
          create: {
            ttlockLockId: Number(newTtlockLockId),
            ttlockLockName: newTtlockLockName ? String(newTtlockLockName) : null,
            propertyId: property.id,
            isActive: true,
          },
          update: {
            // Si ya existía, lo movemos a esta property y lo activamos
            propertyId: property.id,
            isActive: true,
            ttlockLockName: newTtlockLockName ? String(newTtlockLockName) : undefined,
          },
        });

        // Safety: evitar que queden dos activos con mismo property (si ya existía activo en otra property)
        // (Opcional) aquí podrías forzar isActive=false a otros locks duplicados, pero no es necesario si tu negocio lo permite.

        return { deactivated, newLock };
      });

      return res.json({
        ok: true,
        organizationId: orgId,
        propertyId: property.id,
        swapped: {
          oldTtlockLockId: Number(oldTtlockLockId),
          newTtlockLockId: Number(newTtlockLockId),
        },
        lock: {
          deactivatedId: result.deactivated.id,
          newLockId: result.newLock.id,
        },
      });
    } catch (e: any) {
      console.error("admin/locks/swap error:", e?.message ?? e);
      return res.status(500).json({ ok: false, error: e?.message ?? "swap failed" });
    }
  });

  return router;
}
