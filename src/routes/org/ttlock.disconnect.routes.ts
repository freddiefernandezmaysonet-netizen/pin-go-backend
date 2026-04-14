import { Router } from "express";
import { PrismaClient } from "@prisma/client";
import { requireOrg } from "../../middleware/requireOrg";

const prisma = new PrismaClient();
const router = Router();

/**
 * DELETE /api/org/ttlock/disconnect
 *
 * Desconecta TTLock de la organización:
 * - NO elimina locks
 * - NO elimina access grants
 * - Desactiva locks de la organización
 * - Elimina credenciales TTLock
 */
router.delete(
  "/ttlock/disconnect",
  requireOrg(prisma),
  async (req, res) => {
    try {
      const orgId = String((req as any).orgId ?? "").trim();

      if (!orgId) {
        return res.status(400).json({
          error: "Missing organization context",
        });
      }

      // 1) Validar conexión existente
      const auth = await prisma.tTLockAuth.findFirst({
        where: { organizationId: orgId },
      });

      if (!auth) {
        return res.status(400).json({
          error: "TTLock is not connected",
        });
      }

      // 2) Buscar locks de la organización
      // No filtramos por ttlockLockId porque en tu schema ese campo no acepta null.
      const locks = await prisma.lock.findMany({
        where: {
          property: {
            organizationId: orgId,
          },
        },
        select: { id: true },
      });

      const lockIds = locks.map((l) => l.id);

      // 3) Contar access grants activos asociados a esos locks
      const activeGrantsCount =
        lockIds.length > 0
          ? await prisma.accessGrant.count({
              where: {
                lockId: { in: lockIds },
                status: "ACTIVE",
              },
            })
          : 0;

      // 4) Transacción segura
      await prisma.$transaction(async (tx) => {
        // 4.1 Desactivar locks asociados a la organización
        if (lockIds.length > 0) {
          await tx.lock.updateMany({
            where: {
              id: { in: lockIds },
            },
            data: {
              isActive: false,
            },
          });
        }

        // 4.2 Eliminar credenciales TTLock de la organización
        await tx.tTLockAuth.deleteMany({
          where: { organizationId: orgId },
        });
      });

      // 5) Respuesta clara
      return res.json({
        success: true,
        disconnectedLocks: lockIds.length,
        activeGrantsWarning: activeGrantsCount,
        message:
          activeGrantsCount > 0
            ? "TTLock disconnected. Some active access codes may stop working."
            : "TTLock disconnected successfully",
      });
    } catch (error: any) {
      console.error("[TTLock Disconnect ERROR]", error);

      return res.status(500).json({
        error:
          error?.message && typeof error.message === "string"
            ? error.message
            : "Failed to disconnect TTLock",
      });
    }
  }
);

export default router;