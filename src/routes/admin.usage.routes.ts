import { Router } from "express";
import { PrismaClient } from "@prisma/client";

const router = Router();
const prisma = new PrismaClient();

/** Admin key middleware */
router.use((req, res, next) => {
  const key = req.header("x-admin-key");
  const expected = process.env.ADMIN_KEY;

  if (!expected) return res.status(500).json({ ok: false, error: "ADMIN_KEY not configured" });
  if (!key || key !== expected) return res.status(401).json({ ok: false, error: "Unauthorized" });
  next();
});

/**
 * GET /api/admin/org/:orgId/locks/usage
 * Devuelve entitledLocks/usedLocks + lista de locks activos
 */
router.get("/org/:orgId/locks/usage", async (req, res) => {
  try {
    const orgId = String(req.params.orgId || "").trim();
    if (!orgId) return res.status(400).json({ ok: false, error: "orgId required" });

    // 1) Cuenta locks activos (siempre la fuente de verdad del cupo)
    const usedLocks = await prisma.lock.count({
      where: {
        isActive: true,
        property: { organizationId: orgId },
      },
    });

    // 2) Lista locks activos (para UI/soporte)
    const activeLocks = await prisma.lock.findMany({
      where: {
        isActive: true,
        property: { organizationId: orgId },
      },
      select: {
        id: true,
        ttlockLockId: true,
        ttlockLockName: true,
        propertyId: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: { updatedAt: "desc" },
    });

    // 3) Entitled: usa tu lógica existente (si ya tienes assertLockCapacity, perfecto)
    // Aquí lo dejo genérico: reemplaza con tu fuente real (Stripe/Subscription/Organization)
    const entitledLocks = Number(req.query.entitled ?? 0); // <- placeholder simple si quieres probar rápido

    return res.json({
      ok: true,
      orgId,
      entitledLocks,
      usedLocks,
      activeLocks,
    });
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message ?? "usage failed" });
  }
});

export default router;
