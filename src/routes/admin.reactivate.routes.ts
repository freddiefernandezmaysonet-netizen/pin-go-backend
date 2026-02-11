import { Router } from "express";
import { PrismaClient, AccessGrantType, AccessStatus } from "@prisma/client";

const router = Router();
const prisma = new PrismaClient();

/**
 * Admin key middleware (simple y efectivo)
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
 * POST /api/admin/org/:orgId/reactivate-suspended
 * Cambia SUSPENDED -> PENDING para grants GUEST activos por ventana de tiempo.
 */
router.post("/org/:orgId/reactivate-suspended", async (req, res) => {
  const orgId = String(req.params.orgId || "").trim();
  if (!orgId) return res.status(400).json({ ok: false, error: "orgId required" });

  const now = new Date();

  try {
    const result = await prisma.accessGrant.updateMany({
      where: {
        type: AccessGrantType.GUEST,
        status: AccessStatus.SUSPENDED,
        startsAt: { lte: now },
        endsAt: { gt: now },

        // ✅ AccessGrant -> Reservation -> Property -> Organization
        reservation: {
          is: {
            property: {
              is: { organizationId: orgId },
            },
          },
        },
      },
      data: {
        status: AccessStatus.PENDING,
        lastError: null,
      },
    });

    return res.json({
      ok: true,
      orgId,
      now: now.toISOString(),
      reactivated: result.count,
    });
  } catch (e: any) {
    return res.status(500).json({
      ok: false,
      error: e?.message ?? String(e),
    });
  }
});

export default router;
