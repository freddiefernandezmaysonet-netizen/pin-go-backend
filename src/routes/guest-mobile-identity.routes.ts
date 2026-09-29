import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { exchangeGuestStayToken } from "../guest-mobile/guest-mobile-session.service.js";
import { createReviewRateLimit, reviewClientKey } from "../services/reviews/review-route-security.js";

export const guestMobileIdentityRouter = Router();

guestMobileIdentityRouter.post(
  "/api/guest-mobile/session/exchange",
  createReviewRateLimit({
    namespace: "guest-mobile-session-exchange",
    max: 20,
    windowMs: 60_000,
    key: reviewClientKey,
  }),
  async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");

    const body =
      req.body && typeof req.body === "object" && !Array.isArray(req.body)
        ? req.body as Record<string, unknown>
        : {};

    const allowed = new Set(["guestToken", "deviceLabel", "platform"]);
    if (Object.keys(body).some(key => !allowed.has(key))) {
      return res.status(400).json({ ok: false, error: "INVALID_REQUEST" });
    }

    try {
      const result = await exchangeGuestStayToken(prisma, {
        guestToken: body.guestToken,
        deviceLabel: typeof body.deviceLabel === "string" ? body.deviceLabel : null,
        platform: typeof body.platform === "string" ? body.platform : null,
      });

      return res.status(201).json({
        ok: true,
        sessionToken: result.bearer,
        expiresAt: result.expiresAt.toISOString(),
        stay: result.stay,
      });
    } catch (error) {
      const code = error instanceof Error ? error.message : "GUEST_MOBILE_EXCHANGE_FAILED";
      if (
        code === "GUEST_MOBILE_INVALID_STAY_TOKEN" ||
        code === "GUEST_MOBILE_STAY_NOT_AVAILABLE" ||
        code === "GUEST_MOBILE_STAY_LINK_REVOKED"
      ) {
        return res.status(404).json({ ok: false, error: "STAY_NOT_AVAILABLE" });
      }
      console.error("[GUEST_MOBILE_SESSION_EXCHANGE] failed", { code });
      return res.status(500).json({ ok: false, error: "GUEST_MOBILE_EXCHANGE_FAILED" });
    }
  },
);
