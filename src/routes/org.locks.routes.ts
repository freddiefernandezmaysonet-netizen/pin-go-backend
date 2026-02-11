import { Router } from "express";
import type { PrismaClient } from "@prisma/client";
import { assertLockCapacity } from "../services/lockCapacity.service";
import { requireOrg } from "../middleware/requireOrg";

export function buildOrgLocksRouter(prisma: PrismaClient) {
  const router = Router();

  // ✅ org context (sin pedir organizationId en body)
  router.use(requireOrg);

  /**
   * POST /api/org/locks/activate
   * Body: { propertyId, ttlockLockId, ttlockLockName?, swapOutTtlockLockId? }
   *
   * - Si swapOutTtlockLockId viene: swap 1x1 (NO consume cupo)
   * - Si lock ya existe: reusa (NO consume cupo)
   * - Si lock es nuevo y NO swap: valida capacity (consume cupo)
   */
  router.post("/locks/activate", async (req, res) => {
    try {
      const orgId = String((req as any).orgId);
      const { propertyId, ttlockLockId, ttlockLockName, swapOutTtlockLockId } = req.body ?? {};

      if (!propertyId || !ttlockLockId) {
        return res.status(400).json({
          ok: false,
          error: "Missing propertyId or ttlockLockId",
        });
      }

      // 1) Validar property pertenece a la org del request
      const property = await prisma.property.findUnique({
        where: { id: String(propertyId) },
        select: { id: true, organizationId: true },
      });

      if (!property) return res.status(404).json({ ok: false, error: "Property not found" });
      if (property.organizationId !== orgId) {
        return res.status(409).json({ ok: false, error: "PROPERTY_NOT_IN_ORG" });
      }

      // 2) Si el lock YA existe en DB por ttlockLockId => reusar (no consume cupo)
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
        if (existingLock.property.organizationId !== orgId) {
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

      // 3) SWAP por ttlockId (NO usar ID prisma)
      if (swapOutTtlockLockId) {
        const swapOut = await prisma.lock.findUnique({
          where: { ttlockLockId: Number(swapOutTtlockLockId) },
          select: {
            id: true,
            isActive: true,
            property: { select: { organizationId: true } },
          },
        });

        if (!swapOut) {
          return res.status(404).json({ ok: false, error: "SWAP_OUT_LOCK_NOT_FOUND" });
        }
        if (!swapOut.isActive) {
          return res.status(409).json({ ok: false, error: "SWAP_OUT_LOCK_NOT_ACTIVE" });
        }
        if (swapOut.property.organizationId !== orgId) {
          return res.status(409).json({ ok: false, error: "SWAP_OUT_LOCK_OTHER_ORG" });
        }

        const result = await prisma.$transaction(async (tx) => {
          await tx.lock.update({
            where: { id: swapOut.id },
            data: { isActive: false },
          });

          const newLock = await tx.lock.create({
            data: {
              ttlockLockId: Number(ttlockLockId),
              propertyId: property.id,
              ttlockLockName: ttlockLockName ?? null,
              isActive: true,
            },
          });

          return { deactivatedId: swapOut.id, newLockId: newLock.id, newLock };
        });

        return res.json({
          ok: true,
          swapped: true,
          swappedBy: "ttlockLockId",
          oldTtlockLockId: Number(swapOutTtlockLockId),
          newTtlockLockId: Number(ttlockLockId),
          lock: result.newLock,
        });
      }

      // 4) Lock nuevo sin swap => validar capacity
      const capacity = await assertLockCapacity(prisma, orgId, 1);

      if (!capacity.ok) {
        if ((capacity as any).error === "SUBSCRIPTION_INACTIVE") {
          return res.status(402).json({
            ok: false,
            error: "SUBSCRIPTION_INACTIVE",
            entitledLocks: capacity.entitled,
            usedLocks: capacity.used,
            status: capacity.status,
          });
        }

        return res.status(402).json({
          ok: false,
          error: "LOCK_LIMIT_REACHED",
          entitledLocks: capacity.entitled,
          usedLocks: capacity.used,
          status: capacity.status,
        });
      }

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
      console.error("org/locks/activate error:", e?.message ?? e);
      return res.status(500).json({ ok: false, error: e?.message ?? "activate failed" });
    }
  });

  return router;
}
