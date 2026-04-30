import { Router } from "express";
import { PrismaClient } from "@prisma/client";
import { requireAuth } from "../middleware/requireAuth";
import { sendSalesFollowUpEmail } from "../lib/mailer";

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
  "/api/internal/admin/sales-followups",
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
        include: {
          appointment: true,
        },
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

// ✉️ SEND MANUAL FOLLOW-UP EMAIL
adminSalesFollowupsRouter.post(
  "/api/internal/admin/sales-followups/:id/send-email",
  requireAuth,
  async (req, res) => {
    try {
      if (!assertPlatformAdmin(req, res)) return;

      const { id } = req.params;

      const followUp = await prisma.salesFollowUp.findUnique({
        where: { id },
        include: {
          appointment: true,
        },
      });

      if (!followUp) {
        return res.status(404).json({
          ok: false,
          error: "Follow-up not found",
        });
      }

      if (followUp.status !== "READY_TO_SEND") {
        return res.status(400).json({
          ok: false,
          error: `Follow-up is not ready to send. Current status: ${followUp.status}`,
        });
      }

      const email = followUp.appointment?.email?.trim();

      if (!email) {
        return res.status(400).json({
          ok: false,
          error: "No email found for this lead",
        });
      }

      const result = await sendSalesFollowUpEmail({
        to: email,
        name: followUp.appointment?.name,
      });

      const updated = await prisma.salesFollowUp.update({
        where: { id },
        data: {
          status: "COMPLETED",
          completedAt: new Date(),
          notes: `Email follow-up sent manually via ${result.mode}`,
        },
      });

      return res.json({
        ok: true,
        mode: result.mode,
        followUp: updated,
      });
    } catch (error: any) {
      console.error("[ADMIN_SALES_FOLLOWUP_EMAIL_ERROR]", error);

      return res.status(500).json({
        ok: false,
        error: "Failed to send follow-up email",
        detail: error?.message ?? String(error),
      });
    }
  }
);

// ✅ MARK AS CONTACTED
adminSalesFollowupsRouter.post(
  "/api/internal/admin/sales-followups/:id/contacted",
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