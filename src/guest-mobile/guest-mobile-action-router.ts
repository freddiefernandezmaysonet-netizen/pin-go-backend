import { Router, type Router as ExpressRouter } from "express";
import type { PrismaClient } from "@prisma/client";
import { resolveGuestMobileSession, resolveGuestMobilePinAIScope } from "./guest-mobile-session.service.js";

// Adapt only authentication and routing. Consent, pricing, payment, receipts,
// availability and execution remain in the existing public Pin AI router.
export function buildGuestMobileActionRouter(input: { prisma: PrismaClient; actions: ExpressRouter }) {
  const router = Router();
  router.use("/api/guest-mobile/stays/:reservationNumber/pin-ai/action-proposals", async (req, res, next) => {
    res.setHeader("Cache-Control", "no-store, private");
    res.setHeader("Referrer-Policy", "no-referrer");
    const path = /^\/([A-Za-z0-9_-]{8,128})\/(confirm|status)$/.exec(req.path);
    if (!path || (path[2] === "confirm" ? req.method !== "POST" : req.method !== "GET")) {
      return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    }
    const bearer = /^Bearer\s+([^\s]+)$/i.exec(String(req.get("authorization") ?? ""));
    if (!bearer) return res.status(401).json({ ok: false, error: "UNAUTHENTICATED" });
    try {
      const session = await resolveGuestMobileSession(input.prisma, bearer[1]);
      const scope = await resolveGuestMobilePinAIScope(input.prisma, {
        guestPersonId: session.guestPersonId, reservationNumber: req.params.reservationNumber,
      });
      const original = req.url;
      req.url = `/manage/${encodeURIComponent(scope.guestToken)}/pin-ai/action-proposals/${path[1]}/${path[2]}`;
      input.actions(req, res, error => { req.url = original; next(error); });
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      if (["GUEST_MOBILE_UNAUTHENTICATED", "GUEST_MOBILE_INVALID_STAY_TOKEN"].includes(code)) {
        return res.status(401).json({ ok: false, error: "UNAUTHENTICATED" });
      }
      if (code === "GUEST_MOBILE_PIN_AI_NOT_AVAILABLE") {
        return res.status(404).json({ ok: false, error: "ACTION_PROPOSAL_NOT_FOUND" });
      }
      return res.status(503).json({ ok: false, error: "PIN_AI_ACTIONS_UNAVAILABLE" });
    }
  });
  return router;
}
