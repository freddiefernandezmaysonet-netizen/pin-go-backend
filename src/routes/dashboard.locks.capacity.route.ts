import { Router } from "express";
import { PrismaClient } from "@prisma/client";
import { requireAuth } from "../middleware/requireAuth";
import { assertLockCapacity } from "../services/lockCapacity.service";

const prisma = new PrismaClient();
export const dashboardLocksCapacityRouter = Router();

/**
 * GET /api/dashboard/locks/capacity
 *
 * Devuelve capacidad del plan de locks para la org autenticada:
 * - entitledLocks
 * - usedLocks
 * - remainingLocks
 * - utilizationPct
 * - status
 */
dashboardLocksCapacityRouter.get(
  "/api/dashboard/locks/capacity",
  requireAuth,
  async (req, res) => {
    try {
      const user = (req as any).user;
      const orgId = String(user?.orgId ?? "").trim();

      if (!orgId) {
        return res.status(401).json({
          ok: false,
          error: "ORG_CONTEXT_MISSING",
        });
      }

      const cap = await assertLockCapacity(prisma, orgId, 0);

      const entitledLocks = Number(cap.entitled ?? 0);
      const usedLocks = Number(cap.used ?? 0);
      const remainingLocks = Number(cap.remaining ?? Math.max(entitledLocks - usedLocks, 0));

      const utilizationPct =
        entitledLocks > 0
          ? Math.min(100, Math.max(0, Math.round((usedLocks / entitledLocks) * 100)))
          : 0;

      return res.json({
        ok: true,
        orgId,
        entitledLocks,
        usedLocks,
        remainingLocks,
        utilizationPct,
        status: cap.status ?? null,
      });
    } catch (e: any) {
      console.error("dashboard/locks/capacity error:", e?.message ?? e);
      return res.status(500).json({
        ok: false,
        error: e?.message ?? "locks capacity failed",
      });
    }
  }
);