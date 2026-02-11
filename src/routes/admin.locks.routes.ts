import { Router } from "express";
import { PrismaClient } from "@prisma/client";
import { assertLockCapacity } from "../services/lockCapacity.service";

export function buildAdminLocksRouter(prisma: PrismaClient) {
  const router = Router();

  /**
   * POST /api/admin/locks/activate
   * Body:
   *  - { propertyId, ttlockLockId, ttlockLockName? }                // alta normal
   *  - { propertyId, ttlockLockId, ttlockLockName?, swapOutTtlockLockId } // swap 1x1 por TTLock ID
   */
  router.post("/locks/activate", async (req, res) => {
    try {
      const { propertyId, ttlockLockId, ttlockLockName, swapOutTtlockLockId } = req.body ?? {};

      if (!propertyId || !ttlockLockId) {
        return res.status(400).json({ ok: false, error: "Missing propertyId or ttlockLockId" });
      }

      // 1) Resolver org desde property
      const property = await prisma.property.findUnique({
        where: { id: String(propertyId) },
        select: { id: true, organizationId: true },
      });
      if (!property) return res.status(404).json({ ok: false, error: "Property not found" });

      // 2) Si el lock YA existe (por ttlockLockId), no consume cupo
      const existingLock = await prisma.lock.findUnique({
        where: { ttlockLockId: Number(ttlockLockId) },
        select: {
          id: true,
          isActive: true,
          propertyId: true,
          property: { select: { organizationId: true } },
        },
      });

      if (existingLock) {
        if (existingLock.property.organizationId !== property.organizationId) {
          return res.status(409).json({ ok: false, error: "LOCK_BELONGS_TO_ANOTHER_ORG" });
        }

        const lock = await prisma.lock.update({
          where: { id: existingLock.id },
          data: {
            propertyId: property.id,
            ttlockLockName: ttlockLockName ?? undefined,
            isActive: true,
          },
        });

        return res.json({
          ok: true,
          reused: true,
          lock,
          message: "Lock already registered. No slot consumed.",
        });
      }

      // 3) Lock nuevo (no existe en DB)

      // ✅ SWAP por TTLock ID (NO Prisma id)
      if (swapOutTtlockLockId) {
        const swapOut = await prisma.lock.findFirst({
          where: {
            ttlockLockId: Number(swapOutTtlockLockId),
            isActive: true,
            property: { organizationId: property.organizationId },
          },
          select: {
            id: true,
            ttlockLockId: true,
            isActive: true,
            propertyId: true,
          },
        });

        if (!swapOut) {
          return res.status(404).json({ ok: false, error: "SWAP_OUT_LOCK_NOT_FOUND" });
        }

        // (opcional) si quieres exigir que sea de la misma property, activa esto:
        // if (swapOut.propertyId !== property.id) {
        //   return res.status(409).json({ ok: false, error: "SWAP_OUT_LOCK_DIFFERENT_PROPERTY" });
        // }

        const result = await prisma.$transaction(async (tx) => {
          // 1) desactiva la vieja
          await tx.lock.update({
            where: { id: swapOut.id },
            data: { isActive: false },
          });

          // 2) crea la nueva activa
          const newLock = await tx.lock.create({
            data: {
              ttlockLockId: Number(ttlockLockId),
              propertyId: property.id,
              ttlockLockName: ttlockLockName ?? null,
              isActive: true,
            },
          });

          return { deactivatedId: swapOut.id, newLock };
        });

        return res.json({
          ok: true,
          swapped: true,
          swapOutTtlockLockId: Number(swapOutTtlockLockId),
          deactivatedId: result.deactivatedId,
          lock: result.newLock,
        });
      }

      // NO swap => validar capacity (aquí sí)
      const capacity = await assertLockCapacity(prisma, property.organizationId, 1);

      if (!capacity.ok) {
        return res.status(402).json({
          ok: false,
          error: "LOCK_LIMIT_REACHED",
          entitledLocks: capacity.entitled,
          usedLocks: capacity.used,
          status: capacity.status,
        });
      }

      // crear normal
      const lock = await prisma.lock.create({
        data: {
          ttlockLockId: Number(ttlockLockId),
          propertyId: property.id,
          ttlockLockName: ttlockLockName ?? null,
          isActive: true,
        },
      });

      return res.json({ ok: true, created: true, lock });
    } catch (e: any) {
      console.error("admin/locks/activate error:", e?.message ?? e);
      return res.status(500).json({ ok: false, error: e?.message ?? "activate failed" });
    }
  });

  return router;
}
