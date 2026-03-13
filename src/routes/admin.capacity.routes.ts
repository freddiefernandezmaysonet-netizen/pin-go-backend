import { Router } from "express";
import { PrismaClient } from "@prisma/client";
import { assertLockCapacity } from "../services/lockCapacity.service";

const router = Router();
const prisma = new PrismaClient();

// mismo admin key
router.use((req, res, next) => {
  const key = req.header("x-admin-key");
  const expected = process.env.ADMIN_KEY;

  if (!expected) return res.status(500).json({ ok: false, error: "ADMIN_KEY not configured" });
  if (!key || key !== expected) return res.status(401).json({ ok: false, error: "Unauthorized" });

  next();
});

// ✅ GET /api/admin/org/:orgId/lock-capacity
router.get("/org/:orgId/lock-capacity", async (req, res) => {
  const orgId = String(req.params.orgId || "").trim();
  if (!orgId) return res.status(400).json({ ok: false, error: "orgId required" });

  const cap = await assertLockCapacity(prisma, orgId, 0);

  const activeLocks = await prisma.lock.findMany({
    where: { isActive: true, property: { organizationId: orgId } },
    select: {
      id: true,
      ttlockLockId: true,
      ttlockLockName: true,
      propertyId: true,
      createdAt: true,
      updatedAt: true,
    },
    orderBy: { createdAt: "asc" },
  });

  return res.json({
    ok: true,
    orgId,
    entitledLocks: cap.entitled,
    usedLocks: cap.used,
    remainingLocks: cap.remaining,
    status: cap.status,
    activeLocks,
  });
});

export default router;