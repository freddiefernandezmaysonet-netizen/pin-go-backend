import { Router } from "express";
import { PrismaClient } from "@prisma/client";
import { verifyLoginEmailMfaChallenge } from "./mfa-login-challenge.js";
import { createAuthSession, createTrustedDevice } from "./trusted-device-session.persistence.js";
import { buildAuthCookie, signAuthToken } from "../lib/auth.js";
import { buildTrustedDeviceCookie } from "./trusted-device-cookie.js";
import { resolveE5RuntimeMode } from "./mfa-login-runtime.js";

const prisma = new PrismaClient();
export const mfaLoginRouter = Router();

function readPepper(): string {
  return String(process.env.PINGO_MFA_OTP_PEPPER ?? "").trim();
}

mfaLoginRouter.post("/auth/mfa/verify", async (req, res) => {
  try {
    const runtime = resolveE5RuntimeMode(process.env.PINGO_MFA_MODE);
    if (runtime.mode === "OFF") {
      return res.status(404).json({ error: "MFA_NOT_ACTIVE" });
    }

    const challengeToken = String(req.body?.challengeToken ?? "").trim();
    const code = String(req.body?.code ?? "").trim();
    const trustDevice = req.body?.trustDevice === true;
    const pepper = readPepper();

    if (!challengeToken || !code) {
      return res.status(400).json({ error: "MFA_CHALLENGE_CODE_REQUIRED" });
    }

    if (pepper.length < 32) {
      return res.status(503).json({ error: "MFA_NOT_CONFIGURED" });
    }

    const verified = await verifyLoginEmailMfaChallenge(prisma as any, {
      challengeToken,
      code,
      pepper,
    });

    if (!verified.ok) {
      const status = verified.reason === "NOT_FOUND" ? 404 : 401;
      return res.status(status).json({ error: `MFA_${verified.reason}` });
    }

    const user = await prisma.dashboardUser.findUnique({
      where: { id: verified.userId },
      select: {
        id: true,
        organizationId: true,
        email: true,
        role: true,
        isActive: true,
        tokenVersion: true,
        organization: { select: { name: true, slug: true } },
      },
    });

    if (!user || !user.isActive) {
      return res.status(401).json({ error: "MFA_USER_UNAVAILABLE" });
    }

    let trustedDeviceId: string | null = null;
    let trustedDeviceCookie: string | null = null;

    if (trustDevice) {
      const trusted = await createTrustedDevice(prisma as any, {
        userId: user.id,
        label: "Trusted browser",
        userAgent: req.get("user-agent") ?? null,
      });
      trustedDeviceId = trusted.trustedDeviceId;
      trustedDeviceCookie = buildTrustedDeviceCookie(trusted.token);
    }

    await createAuthSession(prisma as any, {
      userId: user.id,
      organizationId: user.organizationId,
      tokenVersion: user.tokenVersion,
      trustedDeviceId,
      userAgent: req.get("user-agent") ?? null,
    });

    const token = signAuthToken({
      sub: user.id,
      orgId: user.organizationId,
      email: user.email,
      role: user.role,
      tokenVersion: user.tokenVersion,
    });

    const cookies = [
      buildAuthCookie(token, { requestOrigin: req.get("origin") }),
      ...(trustedDeviceCookie ? [trustedDeviceCookie] : []),
    ];
    res.setHeader("Set-Cookie", cookies);

    return res.json({
      ok: true,
      user: {
        id: user.id,
        email: user.email,
        orgId: user.organizationId,
        role: user.role,
        organizationName: user.organization?.name ?? null,
        organizationSlug: user.organization?.slug ?? null,
      },
      trustedDevice: Boolean(trustedDeviceId),
    });
  } catch (error) {
    console.error("[auth/mfa/verify] ERROR", error);
    return res.status(500).json({ error: "MFA_VERIFY_FAILED" });
  }
});
