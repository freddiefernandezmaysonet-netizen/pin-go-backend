import { Router } from "express";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const router = Router();

// ⚠️ luego mover a config central
const LOCK_PRICE = 7.99;
const SMART_PRICE = 9.99;

const STRIPE_PERCENT = 0.029;
const STRIPE_FIXED = 0.3;
const AVG_SMS_COST = 0.008;
const TUYA_COST = 0.3;

// 👉 TEMP: luego cambiamos a requireAdmin real
function requireAdmin(req: any, res: any, next: any) {
  // puedes validar email o flag aquí
  return next();
}

router.get("/financial/overview", requireAdmin, async (_req, res) => {
  try {
    // =====================
    // GLOBAL COUNTS
    // =====================
    const totalLocks = await prisma.lock.count({
      where: { isActive: true },
    });

    const totalSmart = await prisma.property.count({
      where: { smartAutomationEnabled: true },
    });

    const totalOrgs = await prisma.organization.count();

    const totalReservations = await prisma.reservation.count();

    // =====================
    // REVENUE
    // =====================
    const revenueLocks = totalLocks * LOCK_PRICE;
    const revenueSmart = totalSmart * SMART_PRICE;
    const totalRevenue = revenueLocks + revenueSmart;

    // =====================
    // COSTS
    // =====================
    const stripeFee = totalRevenue * STRIPE_PERCENT + STRIPE_FIXED;

    const sms = totalReservations * 4;
    const twilioCost = sms * AVG_SMS_COST;

    const tuyaCost = totalSmart * TUYA_COST;

    const totalCosts = stripeFee + twilioCost + tuyaCost;

    // =====================
    // PROFIT
    // =====================
    const profit = totalRevenue - totalCosts;
    const margin = totalRevenue > 0 ? (profit / totalRevenue) * 100 : 0;

    return res.json({
      summary: {
        totalOrgs,
        totalLocks,
        totalSmart,
        totalReservations,
      },
      revenue: {
        locks: revenueLocks,
        smart: revenueSmart,
        total: totalRevenue,
      },
      costs: {
        stripe: stripeFee,
        twilio: twilioCost,
        tuya: tuyaCost,
        total: totalCosts,
      },
      profit: {
        net: profit,
        margin,
      },
    });
  } catch (err) {
    console.error("[admin.financial] ERROR", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default router;