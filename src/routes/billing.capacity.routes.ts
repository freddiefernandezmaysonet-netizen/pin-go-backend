import { Router } from "express";
import { PrismaClient } from "@prisma/client";
import stripe from "../billing/stripe";
import { requireAuth } from "../middleware/requireAuth";

const router = Router();
const prisma = new PrismaClient();

/**
 * POST /api/billing/locks/quantity
 * Body: { quantity: number }
 *
 * - Cambia la cantidad TOTAL de locks (no delta)
 * - Usa subscription existente
 * - Aplica proration (Stripe cobra solo diferencia)
 * - Bloquea bajar por debajo de locks activas
 */
router.post("/locks/quantity", requireAuth, async (req, res) => {
  try {
    const user = (req as any).user;
    const orgId = String(user?.orgId ?? "").trim();

    if (!orgId) {
      return res.status(401).json({
        ok: false,
        error: "UNAUTHORIZED",
      });
    }

    const requestedQuantity = Number(req.body?.quantity);

    if (!Number.isInteger(requestedQuantity) || requestedQuantity < 1) {
      return res.status(400).json({
        ok: false,
        error: "INVALID_QUANTITY",
      });
    }

    // 1️⃣ contar locks activas reales
    const activeLocks = await prisma.lock.count({
      where: {
        isActive: true,
        property: {
          organizationId: orgId,
        },
      },
    });

    // 2️⃣ bloquear downgrade inválido
    if (requestedQuantity < activeLocks) {
      return res.status(400).json({
        ok: false,
        error: "SUBSCRIPTION_BELOW_ACTIVE_LOCKS",
        activeLocks,
        requestedQuantity,
      });
    }

    // 3️⃣ obtener subscription actual
    const sub = await prisma.subscription.findUnique({
      where: { organizationId: orgId },
      select: {
        stripeSubscriptionId: true,
        stripeSubscriptionItemId: true,
      },
    });

    if (!sub?.stripeSubscriptionId || !sub?.stripeSubscriptionItemId) {
      return res.status(400).json({
        ok: false,
        error: "SUBSCRIPTION_NOT_READY",
      });
    }

    // 4️⃣ traer estado actual desde Stripe
    const currentSub = await stripe.subscriptions.retrieve(
      sub.stripeSubscriptionId
    );

    const lockItem = currentSub.items.data.find(
      (i: any) => i.id === sub.stripeSubscriptionItemId
    );

    if (!lockItem) {
      return res.status(400).json({
        ok: false,
        error: "LOCK_SUBSCRIPTION_ITEM_NOT_FOUND",
      });
    }

    const currentQuantity = lockItem.quantity ?? 0;

    // 5️⃣ actualizar Stripe con quantity TOTAL (no delta)
    const updated = await stripe.subscriptions.update(
      sub.stripeSubscriptionId,
      {
        items: [
          {
            id: sub.stripeSubscriptionItemId,
            quantity: requestedQuantity,
          },
        ],
        proration_behavior: "create_prorations",
      }
    );

    const updatedLockItem = updated.items.data.find(
      (i: any) => i.id === sub.stripeSubscriptionItemId
    );

    const newQuantity = updatedLockItem?.quantity ?? requestedQuantity;

    return res.json({
      ok: true,
      previousQuantity: currentQuantity,
      newQuantity,
      activeLocks,
    });
  } catch (e: any) {
    console.error("billing capacity update error:", e?.message ?? e);

    return res.status(500).json({
      ok: false,
      error: e?.message ?? "capacity update failed",
    });
  }
});

/**
 * POST /api/billing/smart/quantity
 * Body: { quantity: number }
 *
 * - Cambia la cantidad TOTAL de smart properties (no delta)
 * - Usa la misma subscription existente
 * - Aplica proration
 * - Bloquea bajar por debajo de smart properties activas
 */
router.post("/smart/quantity", requireAuth, async (req, res) => {
  try {
    const user = (req as any).user;
    const orgId = String(user?.orgId ?? "").trim();

    if (!orgId) {
      return res.status(401).json({
        ok: false,
        error: "UNAUTHORIZED",
      });
    }

    const requestedQuantity = Number(req.body?.quantity);

    if (!Number.isInteger(requestedQuantity) || requestedQuantity < 1) {
      return res.status(400).json({
        ok: false,
        error: "INVALID_QUANTITY",
      });
    }

    // 1️⃣ contar smart properties activas reales
    const activeSmartProperties = await prisma.property.count({
      where: {
        organizationId: orgId,
        smartAutomationEnabled: true,
      },
    });

    // 2️⃣ bloquear downgrade inválido
    if (requestedQuantity < activeSmartProperties) {
      return res.status(400).json({
        ok: false,
        error: "SUBSCRIPTION_BELOW_ACTIVE_SMART_PROPERTIES",
        activeSmartProperties,
        requestedQuantity,
      });
    }

    // 3️⃣ obtener subscription actual
    const sub = await prisma.subscription.findUnique({
      where: { organizationId: orgId },
      select: {
        stripeSubscriptionId: true,
      },
    });

    if (!sub?.stripeSubscriptionId) {
      return res.status(400).json({
        ok: false,
        error: "SUBSCRIPTION_NOT_READY",
      });
    }

    const subFull = await prisma.subscription.findUnique({
      where: { organizationId: orgId },
      select: {
        stripeSubscriptionId: true,
        stripeSmartSubscriptionItemId: true,
      },
    });

    if (!subFull?.stripeSubscriptionId || !subFull?.stripeSmartSubscriptionItemId) {
      return res.status(400).json({
        ok: false,
        error: "SMART_SUBSCRIPTION_NOT_READY",
      });
    }

    // traer estado actual desde Stripe
    const currentSub = await stripe.subscriptions.retrieve(
      subFull.stripeSubscriptionId
    );

    const smartItem = currentSub.items.data.find(
      (i: any) => i.id === subFull.stripeSmartSubscriptionItemId
    );

    const currentQuantity = smartItem?.quantity ?? 0;

    // 5️⃣ actualizar mismo subscription item smart con proration
    const updated = await stripe.subscriptions.update(
      sub.stripeSubscriptionId,
      {
        items: [
          {
            id: subFull.stripeSmartSubscriptionItemId,
            quantity: requestedQuantity,
          },
        ],
        proration_behavior: "create_prorations",
      }
    );

    const updatedSmartItem = updated.items.data.find(
      (i: any) => i.id === subFull.stripeSmartSubscriptionItemId
    );

    const newQuantity = updatedSmartItem?.quantity ?? requestedQuantity;

    return res.json({
      ok: true,
      previousQuantity: currentQuantity,
      newQuantity,
      activeSmartProperties,
    });
  } catch (e: any) {
    console.error("billing smart capacity update error:", e?.message ?? e);

    return res.status(500).json({
      ok: false,
      error: e?.message ?? "smart capacity update failed",
    });
  }
});

export default router;