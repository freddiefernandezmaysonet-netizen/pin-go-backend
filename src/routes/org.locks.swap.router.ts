import { Router } from "express";
import type { PrismaClient } from "@prisma/client";
import { assertLockCapacity } from "../services/lockCapacity.service";
import { requireOrg } from "../middleware/requireOrg";

export function buildOrgLocksSwapRouter(prisma: PrismaClient) {
  const router = Router();

  router.use(requireOrg(prisma));

  /**
   * POST /api/org/locks/swap
   * Body: { propertyId, oldTtlockLockId, newTtlockLockId, newTtlockLockName? }
   *
   * Reemplaza 1 lock activa por otra (1:1) dentro de la misma org,
   * sin aumentar el uso neto de locks.
   */
  router.post("/locks/swap", async (req, res) => {
    try {
      const organizationId = String((req as any).orgId ?? "").trim();

      if (!organizationId) {
        return res.status(401).json({
          ok: false,
          error: "ORG_CONTEXT_MISSING",
        });
      }

      const {
        propertyId,
        oldTtlockLockId,
        newTtlockLockId,
        newTtlockLockName,
      } = req.body ?? {};

      const propId = String(propertyId ?? "").trim();
      const oldId = Number(oldTtlockLockId);
      const newId = Number(newTtlockLockId);

      if (!propId || !Number.isFinite(oldId) || !Number.isFinite(newId)) {
        return res.status(400).json({
          ok: false,
          error: "MISSING_SWAP_FIELDS",
        });
      }

      if (oldId <= 0 || newId <= 0) {
        return res.status(400).json({
          ok: false,
          error: "INVALID_TTLOCK_LOCK_ID",
        });
      }

      if (oldId === newId) {
        return res.status(400).json({
          ok: false,
          error: "OLD_AND_NEW_LOCK_CANNOT_MATCH",
        });
      }

      const property = await prisma.property.findFirst({
        where: {
          id: propId,
          organizationId,
        },
        select: {
          id: true,
          organizationId: true,
        },
      });

      if (!property) {
        return res.status(404).json({
          ok: false,
          error: "PROPERTY_NOT_FOUND_FOR_ORG",
        });
      }

      const oldLock = await prisma.lock.findUnique({
        where: { ttlockLockId: oldId },
        select: {
          id: true,
          ttlockLockId: true,
          ttlockLockName: true,
          propertyId: true,
          isActive: true,
          property: {
            select: {
              organizationId: true,
            },
          },
        },
      });

      if (!oldLock) {
        return res.status(404).json({
          ok: false,
          error: "SWAP_OUT_LOCK_NOT_FOUND",
        });
      }

      if (oldLock.property.organizationId !== organizationId) {
        return res.status(409).json({
          ok: false,
          error: "SWAP_OUT_LOCK_OTHER_ORG",
        });
      }

      if (oldLock.propertyId !== property.id) {
        return res.status(409).json({
          ok: false,
          error: "SWAP_OUT_LOCK_NOT_IN_PROPERTY",
        });
      }

      if (!oldLock.isActive) {
        return res.status(409).json({
          ok: false,
          error: "SWAP_OUT_LOCK_NOT_ACTIVE",
        });
      }

      const existingNewLock = await prisma.lock.findUnique({
        where: { ttlockLockId: newId },
        select: {
          id: true,
          ttlockLockId: true,
          ttlockLockName: true,
          propertyId: true,
          isActive: true,
          property: {
            select: {
              organizationId: true,
            },
          },
        },
      });

      if (
        existingNewLock &&
        existingNewLock.property.organizationId !== organizationId
      ) {
        return res.status(409).json({
          ok: false,
          error: "NEW_LOCK_BELONGS_TO_ANOTHER_ORG",
        });
      }

      const cap = await assertLockCapacity(prisma, organizationId, 0);

      if (!cap.ok) {
        return res.status(403).json({
          ok: false,
          error: cap.code ?? "LOCK_CAPACITY_INVALID",
          entitledLocks: cap.entitled,
          usedLocks: cap.used,
          status: cap.status,
        });
      }

      const result = await prisma.$transaction(async (tx) => {
        const deactivated = await tx.lock.update({
          where: { id: oldLock.id },
          data: { isActive: false },
          select: {
            id: true,
            ttlockLockId: true,
            propertyId: true,
            isActive: true,
          },
        });

        const newLock = await tx.lock.upsert({
          where: { ttlockLockId: newId },
          create: {
            ttlockLockId: newId,
            ttlockLockName: newTtlockLockName
              ? String(newTtlockLockName).trim()
              : null,
            propertyId: property.id,
            isActive: true,
          },
          update: {
            propertyId: property.id,
            isActive: true,
            ttlockLockName: newTtlockLockName
              ? String(newTtlockLockName).trim()
              : undefined,
          },
          select: {
            id: true,
            ttlockLockId: true,
            ttlockLockName: true,
            propertyId: true,
            isActive: true,
          },
        });

        return { deactivated, newLock };
      });

      return res.json({
        ok: true,
        swapped: true,
        organizationId,
        propertyId: property.id,
        oldTtlockLockId: oldId,
        newTtlockLockId: newId,
        deactivatedLock: result.deactivated,
        lock: result.newLock,
      });
    } catch (e: any) {
      console.error("org/locks/swap error:", e?.message ?? e);
      return res.status(500).json({
        ok: false,
        error: e?.message ?? "swap failed",
      });
    }
  });

  return router;
}