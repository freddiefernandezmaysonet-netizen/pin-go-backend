import { Router } from "express";
import type { PrismaClient } from "@prisma/client";
import { assertLockCapacity } from "../services/lockCapacity.service";
import { requireOrg } from "../middleware/requireOrg";

export function buildOrgLocksActivateV2Router(prisma: PrismaClient) {
  const router = Router();

  router.use(requireOrg(prisma));

  /**
   * POST /api/org/locks/activate
   * Body:
   * {
   *   propertyId: string,
   *   ttlockLockId: number,
   *   ttlockLockName?: string
   * }
   */
  router.post("/locks/activate", async (req: any, res) => {
    try {
      const orgId = req.orgId;

      const { propertyId, ttlockLockId, ttlockLockName } = req.body ?? {};

      if (!propertyId || !ttlockLockId) {
        return res.status(400).json({
          ok: false,
          error: "MISSING_FIELDS",
        });
      }

      const lockIdNum = Number(ttlockLockId);

      if (!Number.isFinite(lockIdNum)) {
        return res.status(400).json({
          ok: false,
          error: "INVALID_TTLOCK_LOCK_ID",
        });
      }

      // 1️⃣ validar property pertenece a la org
      const property = await prisma.property.findUnique({
        where: { id: String(propertyId) },
        select: { id: true, organizationId: true },
      });

      if (!property) {
        return res.status(404).json({
          ok: false,
          error: "PROPERTY_NOT_FOUND",
        });
      }

      if (property.organizationId !== orgId) {
        return res.status(409).json({
          ok: false,
          error: "PROPERTY_NOT_IN_ORG",
        });
      }

      // 2️⃣ revisar si lock ya existe
      const existing = await prisma.lock.findUnique({
        where: { ttlockLockId: lockIdNum },
        select: {
          id: true,
          propertyId: true,
          isActive: true,
          property: { select: { organizationId: true } },
        },
      });

      // 3️⃣ lock ya existe
      if (existing) {
        if (existing.property.organizationId !== orgId) {
          return res.status(409).json({
            ok: false,
            error: "LOCK_BELONGS_TO_ANOTHER_ORG",
          });
        }

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

      // 4️⃣ validar capacidad (lock nueva)
      const capacity = await assertLockCapacity(prisma as any, orgId, 1);

      if (!capacity.ok) {
        return res.status(402).json({
          ok: false,
          error: "LOCK_LIMIT_REACHED",
          entitledLocks: capacity.entitled,
          usedLocks: capacity.used,
          status: capacity.status,
        });
      }

      // 5️⃣ crear lock
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
      console.error("org/locks/activate.v2 error:", e?.message ?? e);

      return res.status(500).json({
        ok: false,
        error: e?.message ?? "activate failed",
      });
    }
  });

  return router;
}