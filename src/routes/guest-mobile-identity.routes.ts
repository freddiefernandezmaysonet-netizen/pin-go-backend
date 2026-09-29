import { Router, type RequestHandler } from "express";
import { prisma } from "../lib/prisma.js";
import { exchangeGuestStayToken, readGuestMobileStay, resolveGuestMobilePinAIScope, resolveGuestMobileSession } from "../guest-mobile/guest-mobile-session.service.js";
import { GuestPinAIGateway, createGuestPinAIRuntimeRunner } from "../pin-ai/guest/guest-runtime-gateway.js";
import { readGuestHistory } from "../pin-ai/guest/guest-history-reader.js";

const exchangeAttempts = new Map<string, { count: number; resetAt: number }>();

const exchangeRateLimit: RequestHandler = (req, res, next) => {
  const now = Date.now();
  const key = String(req.ip ?? req.socket.remoteAddress ?? "unknown");
  const current = exchangeAttempts.get(key);
  if (!current || current.resetAt <= now) {
    exchangeAttempts.set(key, { count: 1, resetAt: now + 60_000 });
    next();
    return;
  }
  if (current.count >= 20) {
    res.status(429).json({ ok: false, error: "RATE_LIMITED" });
    return;
  }
  current.count += 1;
  next();
};

export const guestMobileIdentityRouter = Router();

guestMobileIdentityRouter.post(
  "/api/guest-mobile/session/exchange",
  exchangeRateLimit,
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


guestMobileIdentityRouter.get(
  "/api/guest-mobile/stays/:reservationNumber",
  exchangeRateLimit,
  async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");

    const authorization = String(req.get("authorization") ?? "");
    const match = /^Bearer\s+([^\s]+)$/i.exec(authorization);
    if (!match?.[1]) {
      return res.status(401).json({ ok: false, error: "UNAUTHENTICATED" });
    }

    try {
      const session = await resolveGuestMobileSession(prisma, match[1]);
      const stay = await readGuestMobileStay(prisma, {
        guestPersonId: session.guestPersonId,
        reservationNumber: String(req.params.reservationNumber ?? "").trim(),
      });

      return res.json({
        ok: true,
        stay: {
          ...stay,
          checkIn: stay.checkIn.toISOString(),
          checkOut: stay.checkOut.toISOString(),
        },
      });
    } catch (error) {
      const code = error instanceof Error ? error.message : "GUEST_MOBILE_STAY_READ_FAILED";
      if (code === "GUEST_MOBILE_UNAUTHENTICATED") {
        return res.status(401).json({ ok: false, error: "UNAUTHENTICATED" });
      }
      if (code === "GUEST_MOBILE_STAY_NOT_AUTHORIZED") {
        return res.status(404).json({ ok: false, error: "STAY_NOT_AVAILABLE" });
      }
      console.error("[GUEST_MOBILE_STAY_READ] failed", { code });
      return res.status(500).json({ ok: false, error: "GUEST_MOBILE_STAY_READ_FAILED" });
    }
  },
);


guestMobileIdentityRouter.get(
  "/api/guest-mobile/stays/:reservationNumber/pin-ai/history",
  exchangeRateLimit,
  async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const match = /^Bearer\s+([^\s]+)$/i.exec(String(req.get("authorization") ?? ""));
    if (!match?.[1]) return res.status(401).json({ ok: false, error: "UNAUTHENTICATED" });

    try {
      const session = await resolveGuestMobileSession(prisma, match[1]);
      const now = new Date();
      const scope = await resolveGuestMobilePinAIScope(prisma, {
        guestPersonId: session.guestPersonId,
        reservationNumber: String(req.params.reservationNumber ?? "").trim(),
        now,
      });
      const messages = await readGuestHistory(prisma, scope, now);
      return res.json({ ok: true, version: 1, messages });
    } catch (error) {
      const code = error instanceof Error ? error.message : "PIN_AI_HISTORY_UNAVAILABLE";
      if (code === "GUEST_MOBILE_UNAUTHENTICATED") return res.status(401).json({ ok: false, error: "UNAUTHENTICATED" });
      if (code === "GUEST_MOBILE_PIN_AI_NOT_AVAILABLE") return res.status(404).json({ ok: false, error: "PIN_AI_NOT_AVAILABLE" });
      console.error("[GUEST_MOBILE_PIN_AI_HISTORY] failed", { code });
      return res.status(503).json({ ok: false, error: "PIN_AI_HISTORY_UNAVAILABLE" });
    }
  },
);

guestMobileIdentityRouter.post(
  "/api/guest-mobile/stays/:reservationNumber/pin-ai/messages",
  exchangeRateLimit,
  async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const match = /^Bearer\s+([^\s]+)$/i.exec(String(req.get("authorization") ?? ""));
    if (!match?.[1]) return res.status(401).json({ ok: false, error: "UNAUTHENTICATED" });
    const body = req.body && typeof req.body === "object" && !Array.isArray(req.body)
      ? req.body as Record<string, unknown> : {};
    if (Object.keys(body).length !== 1 || !Object.prototype.hasOwnProperty.call(body, "message")) {
      return res.status(400).json({ ok: false, error: "INVALID_REQUEST" });
    }

    try {
      const session = await resolveGuestMobileSession(prisma, match[1]);
      const scope = await resolveGuestMobilePinAIScope(prisma, {
        guestPersonId: session.guestPersonId,
        reservationNumber: String(req.params.reservationNumber ?? "").trim(),
      });
      const gateway = new GuestPinAIGateway(
        prisma,
        createGuestPinAIRuntimeRunner(process.env),
        process.env.PIN_AI_GUEST_GATEWAY_ENABLED === "true",
      );
      const result = await gateway.reply({ guestToken: scope.guestToken, message: body.message });
      return res.json({ ok: true, ...result });
    } catch (error) {
      const code = error instanceof Error ? error.message : "PIN_AI_UNAVAILABLE";
      if (code === "GUEST_MOBILE_UNAUTHENTICATED") return res.status(401).json({ ok: false, error: "UNAUTHENTICATED" });
      if (code === "GUEST_MOBILE_PIN_AI_NOT_AVAILABLE") return res.status(404).json({ ok: false, error: "PIN_AI_NOT_AVAILABLE" });
      console.error("[GUEST_MOBILE_PIN_AI_MESSAGE] failed", { code });
      return res.status(503).json({ ok: false, error: "PIN_AI_UNAVAILABLE" });
    }
  },
);
