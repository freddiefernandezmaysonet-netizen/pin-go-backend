import { Router } from "express";
import type { PrismaClient } from "@prisma/client";
import { guestPinAIInformationEnabled } from "../pin-ai/guest-information-availability.js";

// Read only: the signed payment webhook remains the sole booking/fulfillment path.
// Possession of a checkout id reveals only its state and public property scope.
export function buildCheckoutStatusRouter(
  db: Pick<PrismaClient, "reservation" | "property">,
  env: NodeJS.ProcessEnv = process.env,
) {
  const router = Router();
  router.get("/checkout-status", async (req, res) => {
    res.set("Cache-Control", "no-store");
    const sessionId = req.query.session_id;
    if (typeof sessionId !== "string" || !/^cs_(?:test|live)_[A-Za-z0-9_]{10,200}$/.test(sessionId)) {
      return res.status(400).json({ ok: false, error: "INVALID_CHECKOUT_REFERENCE" });
    }
    try {
      const reservation = await db.reservation.findUnique({
        where: { stripeCheckoutSessionId: sessionId },
        select: {
          status: true, paymentState: true, source: true, externalProvider: true,
          identityVerificationRequiredSnapshot: true,
          property: { select: { id: true, organizationId: true, slug: true,
            organization: { select: { slug: true } } } },
        },
      });
      if (!reservation || (reservation.source !== "DIRECT_BOOKING" && reservation.externalProvider !== "PIN_GO_DIRECT")) {
        return res.json({ ok: true, status: "PENDING" });
      }
      if (reservation.status !== "ACTIVE") return res.json({ ok: true, status: "UNAVAILABLE" });
      if (reservation.paymentState !== "PAID") return res.json({ ok: true, status: "PENDING" });
      const property = reservation.property;
      return res.json({
        ok: true, status: "CONFIRMED",
        identityVerificationRequired: reservation.identityVerificationRequiredSnapshot !== false,
        organizationSlug: property.organization.slug, propertySlug: property.slug,
        pinAIEnabled: await guestPinAIInformationEnabled(db, env, {
          organizationId: property.organizationId, propertyId: property.id,
        }),
      });
    } catch {
      return res.status(503).json({ ok: false, error: "CHECKOUT_STATUS_UNAVAILABLE" });
    }
  });
  return router;
}
