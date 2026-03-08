import { Router } from "express";
import type { PrismaClient } from "@prisma/client";
import { assertLockCapacity } from "../services/lockCapacity.service";
import { requireOrg } from "../middleware/requireOrg";

export function buildOrgLocksRouter(prisma: PrismaClient) {
  const router = Router();

  // ✅ org context (sin pedir organizationId en body)
  router.use(requireOrg);

  async function validatePropertyInOrg(orgId: string, propertyId: string) {
    const property = await prisma.property.findUnique({
      where: { id: String(propertyId) },
      select: { id: true, organizationId: true },
    });

    if (!property) {
      return { ok: false as const, status: 404, error: "Property not found" };
    }

    if (property.organizationId !== orgId) {
      return {
        ok: false as const,
        status: 409,
        error: "PROPERTY_NOT_IN_ORG",
      };
    }

    return { ok: true as const, property };
  }

  async function performSwap(params: {
    orgId: string;
    propertyId: string;
    oldTtlockLockId: number;
    newTtlockLockId: number;
    newTtlockLockName?: string | null;
  }) {
    const { orgId, propertyId, oldTtlockLockId, newTtlockLockId, newTtlockLockName } =
      params;

    if (oldTtlockLockId === newTtlockLockId) {
      return {
        ok: false as const,
        status: 400,
        error: "OLD_AND_NEW_LOCK_CANNOT_MATCH",
      };
    }

    const propertyCheck = await validatePropertyInOrg(orgId, propertyId);
    if (!propertyCheck.ok) return propertyCheck;

    const property = propertyCheck.property;

    const swapOut = await prisma.lock.findUnique({
      where: { ttlockLockId: Number(oldTtlockLockId) },
      select: {
        id: true,
        isActive: true,
        propertyId: true,
        property: { select: { organizationId: true } },
      },
    });

    if (!swapOut) {
      return {
        ok: false as const,
        status: 404,
        error: "SWAP_OUT_LOCK_NOT_FOUND",
      };
    }

    if (!swapOut.isActive) {
      return {
        ok: false as const,
        status: 409,
        error: "SWAP_OUT_LOCK_NOT_ACTIVE",
      };
    }

    if (swapOut.property.organizationId !== orgId) {
      return {
        ok: false as const,
        status: 409,
        error: "SWAP_OUT_LOCK_OTHER_ORG",
      };
    }

    if (swapOut.propertyId !== property.id) {
      return {
        ok: false as const,
        status: 409,
        error: "SWAP_OUT_LOCK_NOT_IN_PROPERTY",
      };
    }

    const existingNewLock = await prisma.lock.findUnique({
      where: { ttlockLockId: Number(newTtlockLockId) },
      select: {
        id: true,
        propertyId: true,
        isActive: true,
        property: { select: { organizationId: true } },
      },
    });

    if (existingNewLock && existingNewLock.property.organizationId !== orgId) {
      return {
        ok: false as const,
        status: 409,
        error: "NEW_LOCK_BELONGS_TO_ANOTHER_ORG",
      };
    }

    const result = await prisma.$transaction(async (tx) => {
      const deactivated = await tx.lock.update({
        where: { id: swapOut.id },
        data: { isActive: false },
      });

      const newLock = existingNewLock
        ? await tx.lock.update({
            where: { id: existingNewLock.id },
            data: {
              propertyId: property.id,
              isActive: true,
              ttlockLockName:
                newTtlockLockName != null ? String(newTtlockLockName) : undefined,
            },
          })
        : await tx.lock.create({
            data: {
              ttlockLockId: Number(newTtlockLockId),
              propertyId: property.id,
              ttlockLockName: newTtlockLockName ?? null,
              isActive: true,
            },
          });

      return { deactivated, newLock };
    });

    return {
      ok: true as const,
      swapped: true,
      swappedBy: "ttlockLockId",
      oldTtlockLockId: Number(oldTtlockLockId),
      newTtlockLockId: Number(newTtlockLockId),
      deactivatedId: result.deactivated.id,
      newLock: result.newLock,
    };
  }

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
      const { propertyId, ttlockLockId, ttlockLockName, swapOutTtlockLockId } =
        req.body ?? {};

      if (!propertyId || !ttlockLockId) {
        return res.status(400).json({
          ok: false,
          error: "Missing propertyId or ttlockLockId",
        });
      }

      const propertyCheck = await validatePropertyInOrg(orgId, String(propertyId));
      if (!propertyCheck.ok) {
        return res
          .status(propertyCheck.status)
          .json({ ok: false, error: propertyCheck.error });
      }

      const property = propertyCheck.property;

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
          return res.status(409).json({
            ok: false,
            error: "LOCK_BELONGS_TO_ANOTHER_ORG",
          });
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

      // 3) SWAP por ttlockId
      if (swapOutTtlockLockId) {
        const swapResult = await performSwap({
          orgId,
          propertyId: String(propertyId),
          oldTtlockLockId: Number(swapOutTtlockLockId),
          newTtlockLockId: Number(ttlockLockId),
          newTtlockLockName: ttlockLockName ?? null,
        });

        if (!swapResult.ok) {
          return res
            .status(swapResult.status)
            .json({ ok: false, error: swapResult.error });
        }

        return res.json({
          ok: true,
          swapped: true,
          swappedBy: swapResult.swappedBy,
          oldTtlockLockId: swapResult.oldTtlockLockId,
          newTtlockLockId: swapResult.newTtlockLockId,
          lock: swapResult.newLock,
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
      return res.status(500).json({
        ok: false,
        error: e?.message ?? "activate failed",
      });
    }
  });

  /**
   * POST /api/org/locks/swap
   * Body: { propertyId, oldTtlockLockId, newTtlockLockId, newTtlockLockName? }
   *
   * Ruta dedicada para el dashboard / Locks Operations.
   */
  router.post("/locks/swap", async (req, res) => {
    try {
      const orgId = String((req as any).orgId);
      const { propertyId, oldTtlockLockId, newTtlockLockId, newTtlockLockName } =
        req.body ?? {};

      if (!propertyId || !oldTtlockLockId || !newTtlockLockId) {
        return res.status(400).json({
          ok: false,
          error: "Missing propertyId, oldTtlockLockId or newTtlockLockId",
        });
      }

      const result = await performSwap({
        orgId,
        propertyId: String(propertyId),
        oldTtlockLockId: Number(oldTtlockLockId),
        newTtlockLockId: Number(newTtlockLockId),
        newTtlockLockName: newTtlockLockName ?? null,
      });

      if (!result.ok) {
        return res.status(result.status).json({
          ok: false,
          error: result.error,
        });
      }

      return res.json({
        ok: true,
        swapped: true,
        propertyId: String(propertyId),
        oldTtlockLockId: result.oldTtlockLockId,
        newTtlockLockId: result.newTtlockLockId,
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