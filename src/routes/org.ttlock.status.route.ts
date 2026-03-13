import { Router } from "express";
import { PrismaClient } from "@prisma/client";
import { requireAuth } from "../middleware/requireAuth";

const prisma = new PrismaClient();
export const orgTtlockStatusRouter = Router();

orgTtlockStatusRouter.get("/api/org/ttlock/status", requireAuth, async (req, res) => {
  try {
    const user = (req as any).user;
    const orgId = user.orgId as string;

    const auth = await prisma.tTLockAuth.findFirst({
      where: { organizationId: orgId },
      select: {
        id: true,
        uid: true,
      },
    });

    if (!auth) {
      return res.json({
        ok: true,
        connected: false,
      });
    }

    return res.json({
      ok: true,
      connected: true,
      uid: auth.uid,
    });
  } catch (e: any) {
    return res.status(500).json({
      ok: false,
      error: e?.message ?? "TTLock status failed",
    });
  }
});