import { Router } from "express";
import { PrismaClient } from "@prisma/client";
import { requireAuth } from "../middleware/requireAuth";

const prisma = new PrismaClient();
export const dashboardLocksRouter = Router();

function toInt(v: any, def: number) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}
function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

dashboardLocksRouter.get("/api/dashboard/locks", requireAuth, async (req, res) => {
  const user = (req as any).user;
  const orgId = user.orgId as string;

  const propertyId = typeof req.query.propertyId === "string" ? req.query.propertyId : undefined;
  const search = typeof req.query.search === "string" ? req.query.search.trim() : "";

  const page = clamp(toInt(req.query.page, 1), 1, 10_000);
  const pageSize = clamp(toInt(req.query.pageSize, 25), 1, 100);

  const where: any = {
    property: { organizationId: orgId },
  };

  if (propertyId) where.propertyId = propertyId;

  if (search) {
    // búsqueda por nombre o lockId
    const maybeId = Number(search);
    where.OR = [
      { ttlockLockName: { contains: search, mode: "insensitive" } },
      ...(Number.isFinite(maybeId) ? [{ ttlockLockId: maybeId }] : []),
    ];
  }

  const skip = (page - 1) * pageSize;

  const [total, rows] = await Promise.all([
    prisma.lock.count({ where }),
    prisma.lock.findMany({
      where,
      orderBy: { updatedAt: "desc" },
      skip,
      take: pageSize,
      select: {
        id: true,
        ttlockLockId: true,
        ttlockLockName: true,
        isActive: true,
        updatedAt: true,
        property: { select: { id: true, name: true } },
      },
    }),
  ]);

  // Battery aún no existe en DB: devolvemos null (listo para futuro cache)
  return res.json({
    page,
    pageSize,
    total,
    items: rows.map((l) => ({
      id: l.id,
      ttlockLockId: l.ttlockLockId,
      name: l.ttlockLockName ?? null,
      isActive: l.isActive,
      updatedAt: l.updatedAt.toISOString(),
      property: l.property,
      battery: null as number | null,        // ← futuro: 0-100
      batteryFresh: false,                   // ← futuro: true cuando venga de cache
    })),
  });
});