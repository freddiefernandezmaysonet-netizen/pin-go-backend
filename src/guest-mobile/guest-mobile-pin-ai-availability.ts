import { Router } from "express";
import type { PrismaClient } from "@prisma/client";
import { resolveGuestMobileSession, resolveGuestMobilePinAIScope } from "./guest-mobile-session.service.js";
import { guestPinAIAvailability } from "../pin-ai/guest/guest-availability.js";
import { commercialPinAIEnabled } from "../pin-ai/property-activation.js";

export function buildGuestMobilePinAIAvailabilityRouter(input: {
  prisma: PrismaClient; env?: NodeJS.ProcessEnv; now?: () => Date;
}) {
  const router = Router();
  router.get("/api/guest-mobile/stays/:reservationNumber/pin-ai/availability", async (req, res) => {
    res.setHeader("Cache-Control", "no-store, private");
    const bearer = /^Bearer\s+([^\s]+)$/i.exec(String(req.get("authorization") ?? ""))?.[1];
    if (!bearer) return res.status(401).json({ ok: false, error: "UNAUTHENTICATED" });
    try {
      const now = input.now?.() ?? new Date();
      const env = input.env ?? process.env;
      const session = await resolveGuestMobileSession(input.prisma, bearer, now);
      const scope = await resolveGuestMobilePinAIScope(input.prisma, {
        guestPersonId: session.guestPersonId, reservationNumber: req.params.reservationNumber, now,
      });
      const reservation = await input.prisma.reservation.findUnique({
        where: { id: scope.reservationId },
        select: { checkIn: true, checkOut: true, status: true, property: { select: { timezone: true } } },
      });
      if (!reservation) return res.status(404).json({ ok: false, error: "PIN_AI_NOT_AVAILABLE" });
      const window = guestPinAIAvailability(reservation, now);
      const commercial = await commercialPinAIEnabled(input.prisma, env, scope);
      return res.json({ ok: true, ...window,
        available: env.PIN_AI_GUEST_GATEWAY_ENABLED === "true" && window.available && commercial !== false,
        timezone: reservation.property.timezone, checkedAt: now });
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      if (["GUEST_MOBILE_UNAUTHENTICATED", "GUEST_MOBILE_INVALID_STAY_TOKEN"].includes(code))
        return res.status(401).json({ ok: false, error: "UNAUTHENTICATED" });
      if (code === "GUEST_MOBILE_PIN_AI_NOT_AVAILABLE")
        return res.status(404).json({ ok: false, error: "PIN_AI_NOT_AVAILABLE" });
      return res.status(503).json({ ok: false, error: "PIN_AI_UNAVAILABLE" });
    }
  });
  return router;
}
