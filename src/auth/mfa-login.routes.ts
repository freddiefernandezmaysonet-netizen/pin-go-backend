import { Router } from "express";
import { PrismaClient } from "@prisma/client";
import { hashOpaqueToken } from "./mfa-core.js";
import { verifyLoginEmailMfaChallenge } from "./mfa-login-challenge.js";
import { resendE6EmailCanary } from "./mfa-canary-flow.js";
import {
  evaluateE7EffectiveMode,
  requiresE7MfaChallenge,
  type E7Environment,
} from "./mfa-global-runtime.js";
import {
  createAuthSession,
  createTrustedDevice,
} from "./trusted-device-session.persistence.js";
import { buildAuthCookie } from "../lib/auth.js";
import { buildTrustedDeviceCookie } from "./trusted-device-cookie.js";
import { signSessionBoundAuthToken } from "./session-bound-token.js";

const prisma = new PrismaClient();
export const mfaLoginRouter = Router();

function readE7Environment(): E7Environment {
  return {
    PINGO_MFA_MODE: process.env.PINGO_MFA_MODE,
    PINGO_MFA_CANARY_USER_IDS: process.env.PINGO_MFA_CANARY_USER_IDS,
    PINGO_MFA_OTP_PEPPER: process.env.PINGO_MFA_OTP_PEPPER,
    PINGO_MFA_EMAIL_DELIVERY: process.env.PINGO_MFA_EMAIL_DELIVERY,
    RESEND_API_KEY: process.env.RESEND_API_KEY,
    EMAIL_FROM: process.env.EMAIL_FROM,
  };
}

type ChallengeUser = {
  id: string;
  organizationId: string;
  email: string;
  role: string;
  isActive: boolean;
  tokenVersion: number;
  organization: {
    name: string;
    slug: string;
  } | null;
};

type ChallengeResolution =
  | {
      ok: true;
      user: ChallengeUser;
      mode: "CANARY" | "ENFORCE";
    }
  | {
      ok: false;
      status: 404 | 503;
      error: "MFA_NOT_ACTIVE" | "MFA_NOT_CONFIGURED";
    };

async function resolveMfaChallengeUser(
  challengeToken: string
): Promise<ChallengeResolution> {
  const token = String(challengeToken ?? "").trim();
  if (!token) {
    return { ok: false, status: 404, error: "MFA_NOT_ACTIVE" };
  }

  const challenge = await prisma.mfaChallenge.findUnique({
    where: { challengeTokenHash: hashOpaqueToken(token) },
    select: { userId: true },
  });
  if (!challenge) {
    return { ok: false, status: 404, error: "MFA_NOT_ACTIVE" };
  }

  const user = await prisma.dashboardUser.findUnique({
    where: { id: challenge.userId },
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
    return { ok: false, status: 404, error: "MFA_NOT_ACTIVE" };
  }

  const effective = evaluateE7EffectiveMode(user.id, readE7Environment());

  if (effective.mode === "ENFORCE" && !effective.ready) {
    return { ok: false, status: 503, error: "MFA_NOT_CONFIGURED" };
  }

  if (!requiresE7MfaChallenge(effective)) {
    return { ok: false, status: 404, error: "MFA_NOT_ACTIVE" };
  }

  return {
    ok: true,
    user,
    mode: effective.mode,
  };
}

mfaLoginRouter.post("/auth/mfa/resend", async (req, res) => {
  try {
    const challengeToken = String(req.body?.challengeToken ?? "").trim();
    if (!challengeToken) {
      return res.status(400).json({ error: "MFA_CHALLENGE_REQUIRED" });
    }

    const resolution = await resolveMfaChallengeUser(challengeToken);
    if (!resolution.ok) {
      return res.status(resolution.status).json({ error: resolution.error });
    }

    const pepper = String(process.env.PINGO_MFA_OTP_PEPPER ?? "").trim();
    const result = await resendE6EmailCanary(prisma as any, {
      challengeToken,
      organizationId: resolution.user.organizationId,
      pepper,
    });

    if (!result.ok) {
      if (result.reason === "COOLDOWN") {
        return res.status(429).json({
          error: "MFA_RESEND_COOLDOWN",
          retryAfterSeconds: result.retryAfterSeconds ?? 60,
        });
      }
      if (result.reason === "EXPIRED") {
        return res.status(410).json({ error: "MFA_EXPIRED" });
      }
      return res.status(404).json({ error: "MFA_CHALLENGE_NOT_AVAILABLE" });
    }

    return res.json({
      ok: true,
      mfaRequired: true,
      challengeToken,
      destination: result.maskedDestination,
      expiresAt: result.expiresAt.toISOString(),
      resendAfterSeconds: result.cooldownSeconds,
    });
  } catch (error) {
    console.error("[auth/mfa/resend] ERROR", error);
    return res.status(500).json({ error: "MFA_RESEND_FAILED" });
  }
});

mfaLoginRouter.post("/auth/mfa/verify", async (req, res) => {
  try {
    const challengeToken = String(req.body?.challengeToken ?? "").trim();
    const code = String(req.body?.code ?? "").trim();
    const trustDevice = req.body?.trustDevice === true;

    if (!challengeToken || !code) {
      return res.status(400).json({ error: "MFA_CHALLENGE_CODE_REQUIRED" });
    }

    const resolution = await resolveMfaChallengeUser(challengeToken);
    if (!resolution.ok) {
      return res.status(resolution.status).json({ error: resolution.error });
    }

    const { user, mode } = resolution;
    const pepper = String(process.env.PINGO_MFA_OTP_PEPPER ?? "").trim();
    const verified = await verifyLoginEmailMfaChallenge(prisma as any, {
      challengeToken,
      code,
      pepper,
    });

    if (!verified.ok) {
      const status =
        verified.reason === "NOT_FOUND"
          ? 404
          : verified.reason === "EXPIRED"
            ? 410
            : verified.reason === "LOCKED"
              ? 423
              : 401;
      return res.status(status).json({ error: `MFA_${verified.reason}` });
    }

    if (verified.userId !== user.id) {
      return res.status(401).json({ error: "MFA_USER_MISMATCH" });
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

      await prisma.securityEvent.create({
        data: {
          userId: user.id,
          organizationId: user.organizationId,
          type: "TRUSTED_DEVICE_CREATED",
          userAgent: req.get("user-agent") ?? null,
          metadata: {
            trustedDeviceId,
            expiresAt: trusted.expiresAt.toISOString(),
          },
        },
      });
    }

    const session = await createAuthSession(prisma as any, {
      userId: user.id,
      organizationId: user.organizationId,
      tokenVersion: user.tokenVersion,
      trustedDeviceId,
      userAgent: req.get("user-agent") ?? null,
    });

    await prisma.securityEvent.create({
      data: {
        userId: user.id,
        organizationId: user.organizationId,
        type: "AUTH_SESSION_CREATED",
        userAgent: req.get("user-agent") ?? null,
        metadata: {
          mode,
          sessionId: session.sessionId,
          trustedDeviceId,
          mfaVerified: true,
        },
      },
    });

    const token = signSessionBoundAuthToken(
      {
        sub: user.id,
        orgId: user.organizationId,
        email: user.email,
        role: user.role,
        tokenVersion: user.tokenVersion,
      },
      session.sessionId
    );

    await prisma.dashboardUser.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    const cookies = [
      buildAuthCookie(token, { requestOrigin: req.get("origin") ?? null }),
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