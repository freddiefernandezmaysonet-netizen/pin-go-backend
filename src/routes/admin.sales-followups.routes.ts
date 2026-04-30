import { Router } from "express";
import { PrismaClient } from "@prisma/client";
import { requireAuth } from "../middleware/requireAuth";

const prisma = new PrismaClient();
export const adminSalesFollowupsRouter = Router();

function assertPlatformAdmin(req: any, res: any) {
  const user = req.user;

  if (!user || user.role !== "PLATFORM_ADMIN") {
    res.status(403).json({
      ok: false,
      error: "Forbidden",
    });
    return false;
  }

  return true;
}

// 🔍 GET LIST
adminSalesFollowupsRouter.get(
  "/api/admin/sales-followups",
  requireAuth,
  async (req, res) => {
    try {
      if (!assertPlatformAdmin(req, res)) return;

      const status =
        typeof req.query.status === "string"
          ? req.query.status.toUpperCase()
          : undefined;

      const where: any = {};

      if (status) {
        where.status = status;
      }

      const followUps = await prisma.salesFollowUp.findMany({
        where,        
        orderBy: {
          dueAt: "asc",
        },
        take: 100,
      });

      return res.json({
        ok: true,
        count: followUps.length,
        followUps,
      });
    } catch (error: any) {
      console.error("[ADMIN_SALES_FOLLOWUPS_ERROR]", error);
return res.status(500).json({
  ok: false,
  error: "Failed to fetch sales follow-ups",
  detail: error?.message ?? String(error),
  code: error?.code,
});
    }
  }
);

// ✅ MARK AS CONTACTED
adminSalesFollowupsRouter.post(
  "/api/admin/sales-followups/:id/contacted",
  requireAuth,
  async (req, res) => {
    try {
      if (!assertPlatformAdmin(req, res)) return;

      const { id } = req.params;

      const existing = await prisma.salesFollowUp.findUnique({
        where: { id },
      });

      if (!existing) {
        return res.status(404).json({
          ok: false,
          error: "Follow-up not found",
        });
      }

      const updated = await prisma.salesFollowUp.update({
        where: { id },
        data: {
          status: "COMPLETED",
          completedAt: new Date(),
          notes: "Contacted manually",
        },
      });

      return res.json({
        ok: true,
        followUp: updated,
      });
    } catch (error: any) {
      console.error("[ADMIN_SALES_FOLLOWUP_CONTACTED_ERROR]", error);

      return res.status(500).json({
        ok: false,
        error: "Failed to mark follow-up as contacted",
      });
    }
  }
);