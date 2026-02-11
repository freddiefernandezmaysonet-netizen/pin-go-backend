import { Router } from "express";
import type { PrismaClient } from "@prisma/client";
import { assertLockCapacity } from "../services/lockCapacity.service";

export function buildOrgLocksActivateRouter(prisma: PrismaClient) {
  const router = Router();

  /**
   * POST /api/org/locks/activate
   * Body: { organizationId, propertyId, ttlockLockId, ttlockLockName? }
   */
  router.post("/locks/activate", async (req, res) => {
    try {
      const { organizationId, propertyId, ttlockLockId, ttlockLockName } = req.body ?? {};

      if (!organizationId || !propertyId || !ttlockLockId) {
        return res.status(400).json({
          ok: false,
          error: "Missing organizationId, propertyId or ttlockLockId",
        });
      }

      const orgId = String(organizationId).trim();
      const propId = String(propertyId).trim();
      const lockIdNum = Number(ttlockLockId);

      if (!orgId || !propId || !Number.isFinite(lockIdNum)) {
        return res.status(400).json({ ok: false, error: "Invalid ids" });
      }

      // 1) Validar property pertenece a org
      const property = await prisma.property.findUnique({
        where: { id: propId },
        select: { id: true, organizationId: true },
      });

      if (!property) return res.status(404).json({ ok: false, error: "Property not found" });
      if (property.organizationId !== orgId) {
        return res.status(409).json({ ok: false, error: "PROPERTY_NOT_IN_ORG" });
      }

      // 2) Si lock YA existe por ttlockLockId => NO consume cupo
      const existing = await prisma.lock.findUnique({
        where: { ttlockLockId: lockIdNum },
        select: {
          id: true,
          isActive: true,
          propertyId: true,
          property: { select: { organizationId: true } },
        },
      });

      if (existing) {
        // seguridad: no permitir que una org “robe” lock de otra org
        if (existing.property.organizationId !== orgId) {
          return res.status(409).json({ ok: false, error: "LOCK_BELONGS_TO_ANOTHER_ORG" });
        }

        // Reusar: mover de property (dentro de la misma org) + activar
        const updated = await prisma.lock.update({
          where: { id: existing.id },
          data: {
            propertyId: property.id,
            ttlockLockName: ttlockLockName ?? undefined,
            isActive: true,
          },
        });

        return res.json({
          ok: true,
          reused: true,
          slotConsumed: false,
          lock: updated,
        });
      }

      // 3) Lock nuevo => validar cupo (aquí SÍ consume)
      const cap = await assertLockCapacity(prisma as any, orgId, 1);

      if (!cap.ok) {
        if ((cap as any).error === "SUBSCRIPTION_INACTIVE") {
          return res.status(402).json({
            ok: false,
            error: "SUBSCRIPTION_INACTIVE",
            entitledLocks: cap.entitled,
            usedLocks: cap.used,
            status: cap.status,
          });
        }

        return res.status(402).json({
          ok: false,
          error: "LOCK_LIMIT_REACHED",
          entitledLocks: cap.entitled,
          usedLocks: cap.used,
          status: cap.status,
        });
      }

      // 4) Crear lock activo
      try {
        const created = await prisma.lock.create({
          data: {
            ttlockLockId: lockIdNum,
            propertyId: property.id,
            ttlockLockName: ttlockLockName ?? null,
            isActive: true,
          },
        });

        return res.json({
          ok: true,
          created: true,
          slotConsumed: true,
          lock: created,
        });
      } catch (e: any) {
        // Si hubo carrera y ya existe (unique ttlockLockId), lo reusamos
        if (e?.code === "P2002") {
          const again = await prisma.lock.findUnique({ where: { ttlockLockId: lockIdNum } });
          return res.json({ ok: true, reused: true, slotConsumed: false, lock: again });
        }
        throw e;
      }
    } catch (e: any) {
      console.error("org/locks/activate error:", e?.message ?? e);
      return res.status(500).json({ ok: false, error: e?.message ?? "activate failed" });
    }
  });

  return router;
}
