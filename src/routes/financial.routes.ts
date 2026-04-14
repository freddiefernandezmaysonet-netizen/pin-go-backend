import { Router } from "express";
import { PrismaClient } from "@prisma/client";
import { requireOrg } from "../middleware/requireOrg";

const prisma = new PrismaClient();
const router = Router();

// Pricing (puedes mover luego a config central)
const LOCK_PRICE = 7.99;
const SMART_PRICE = 9.99;

// Costos estimados
const STRIPE_PERCENT = 0.029;
const STRIPE_FIXED = 0.3;
const AVG_SMS_COST = 0.008;
const TUYA_DEVICE_COST = 0.3;

router.get("/financial/overview", requireOrg(prisma), async (req, res) => {
  try {
    const orgId = String((req as any).orgId);

    // =====================
    // COUNTS
    // =====================
    const activeLocks = await prisma.lock.count({
      where: { organizationId: orgId, isActive: true },
    });

    const activeSmart = await prisma.property.count({
      where: { organizationId: orgId, smartAutomationEnabled: true },
    });

    const reservations = await prisma.reservation.count({
      where: { organizationId: orgId },
    });

    // =====================
    // REVENUE
    // =====================
    const revenueLocks = activeLocks * LOCK_PRICE;
    const revenueSmart = activeSmart * SMART_PRICE;
    const totalRevenue = revenueLocks + revenueSmart;

    // =====================
    // COSTS
    // =====================
    const stripeFee = totalRevenue * STRIPE_PERCENT + STRIPE_FIXED;

    const estimatedSms = reservations * 4; // avg 4 SMS por reserva
    const twilioCost = estimatedSms * AVG_SMS_COST;

    const tuyaCost = activeSmart * TUYA_DEVICE_COST;

    const totalCosts = stripeFee + twilioCost + tuyaCost;

    // =====================
    // PROFIT
    // =====================
    const profit = totalRevenue - totalCosts;
    const margin = totalRevenue > 0 ? (profit / totalRevenue) * 100 : 0;

    // =====================
    // RESPONSE
    // =====================
    return res.json({
      revenue: {
        locks: revenueLocks,
        smart: revenueSmart,
        total: totalRevenue,
      },
      usage: {
        activeLocks,
        activeSmart,
        reservations,
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
  } catch (error) {
    console.error("[financial.overview] ERROR", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;