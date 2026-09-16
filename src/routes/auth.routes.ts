import { Router } from "express";
import { PrismaClient } from "@prisma/client";
import {
  comparePassword,
  buildAuthCookie,
  buildClearAuthCookie,
  extractTokenFromRequest,
  hashPassword,
} from "../lib/auth";
import { validatePasswordPolicy } from "../lib/passwordPolicy";
import {
  forgotPasswordHandler,
  verifyForgotPasswordCodeHandler,
  resetPasswordHandler,
} from "../controllers/password.controller";
import { mfaLoginRouter } from "../auth/mfa-login.routes.js";
import { observeE5ShadowLogin } from "../auth/mfa-login-runtime.js";
import { beginE6EmailCanary } from "../auth/mfa-canary-flow.js";
import { findValidE6TrustedDevice } from "../auth/mfa-canary-runtime.js";
import {
  evaluateE7EffectiveMode,
  requiresE7MfaChallenge,
  type E7Environment,
} from "../auth/mfa-global-runtime.js";
import { createAuthSession } from "../auth/trusted-device-session.persistence.js";
import { extractTrustedDeviceToken } from "../auth/trusted-device-cookie.js";
import {
  signSessionBoundAuthToken,
  verifySessionBoundAuthToken,
} from "../auth/session-bound-token.js";
import {
  observeSessionBindingShadow,
  revokeBoundSessionOnLogout,
} from "../auth/session-binding-shadow.js";

const prisma = new PrismaClient();
export const authRouter = Router();
authRouter.use(mfaLoginRouter);

function readE6Environment(): E7Environment {
  return {
    PINGO_MFA_MODE: process.env.PINGO_MFA_MODE,
    PINGO_MFA_CANARY_USER_IDS: process.env.PINGO_MFA_CANARY_USER_IDS,
    PINGO_MFA_OTP_PEPPER: process.env.PINGO_MFA_OTP_PEPPER,
    PINGO_MFA_EMAIL_DELIVERY: process.env.PINGO_MFA_EMAIL_DELIVERY,
    RESEND_API_KEY: process.env.RESEND_API_KEY,
    EMAIL_FROM: process.env.EMAIL_FROM,
  };
}

// =======================
// LOGIN
// =======================
authRouter.post("/auth/login", async (req, res) => {
  try {
    const email = String(req.body?.email ?? "").trim().toLowerCase();
    const password = String(req.body?.password ?? "");

    if (!email || !password) {
      return res.status(400).json({ error: "EMAIL_PASSWORD_REQUIRED" });
    }

    const user = await prisma.dashboardUser.findUnique({
      where: { email },
      select: {
        id: true,
        organizationId: true,
        email: true,
        passwordHash: true,
        role: true,
        isActive: true,
        tokenVersion: true,
        organization: {
          select: {
            name: true,
            slug: true,
          },
        },
      },
    });

    if (!user) {
      return res.status(401).json({ error: "INVALID_CREDENTIALS" });
    }

    if (!user.isActive) {
      return res.status(403).json({ error: "USER_DISABLED" });
    }

    const ok = await comparePassword(password, user.passwordHash);

    if (!ok) {
      return res.status(401).json({ error: "INVALID_CREDENTIALS" });
    }

    const trustedDeviceToken = extractTrustedDeviceToken(req);
    const e6Environment = readE6Environment();
    const e6Runtime = evaluateE7EffectiveMode(user.id, e6Environment);
    let boundSessionId: string | null = null;

    if (e6Runtime.mode === "ENFORCE" && !e6Runtime.ready) {
      console.error("[auth/login][mfa-e7-enforce] CONFIGURATION_BLOCKED", {
        reason: e6Runtime.reason,
      });
      return res.status(503).json({ error: "MFA_NOT_CONFIGURED" });
    }

    const observeShadow = async () => {
      try {
        const observation = await observeE5ShadowLogin(prisma as any, {
          userId: user.id,
          organizationId: user.organizationId,
          email: user.email,
          tokenVersion: user.tokenVersion,
          trustedDeviceToken,
          userAgent: req.get("user-agent") ?? null,
        });
        boundSessionId = observation.sessionId ?? boundSessionId;
        return observation;
      } catch (shadowError) {
        console.error(
          "[auth/login][mfa-e6-shadow] OBSERVATION_FAILED",
          shadowError
        );
        return null;
      }
    };

    if (requiresE7MfaChallenge(e6Runtime)) {
      try {
        const trustedDevice = await findValidE6TrustedDevice(prisma as any, {
          userId: user.id,
          token: trustedDeviceToken,
        });

        if (trustedDevice) {
          const session = await createAuthSession(prisma as any, {
            userId: user.id,
            organizationId: user.organizationId,
            tokenVersion: user.tokenVersion,
            trustedDeviceId: trustedDevice.id,
            userAgent: req.get("user-agent") ?? null,
          });
          boundSessionId = session.sessionId;

          await prisma.securityEvent.create({
            data: {
              userId: user.id,
              organizationId: user.organizationId,
              type: "AUTH_SESSION_CREATED",
              userAgent: req.get("user-agent") ?? null,
              metadata: {
                ...(e6Runtime.mode === "CANARY"
                  ? { mode: "CANARY" }
                  : { mode: "ENFORCE" }),
                sessionId: session.sessionId,
                trustedDeviceId: trustedDevice.id,
                trustedDeviceValid: true,
                mfaBypassed: true,
              },
            },
          });
        } else {
          const challenge = await beginE6EmailCanary(prisma as any, {
            userId: user.id,
            organizationId: user.organizationId,
            email: user.email,
            pepper: String(e6Environment.PINGO_MFA_OTP_PEPPER ?? ""),
          });

          return res.json({
            ok: true,
            mfaRequired: true,
            challengeToken: challenge.challengeToken,
            destination: challenge.maskedDestination,
            expiresAt: challenge.expiresAt.toISOString(),
            resendAfterSeconds: 60,
          });
        }
      } catch (mfaError) {
        if (e6Runtime.failClosed) {
          console.error(
            "[auth/login][mfa-e7-enforce] FAIL_CLOSED",
            mfaError
          );
          return res.status(503).json({ error: "MFA_DELIVERY_FAILED" });
        }

        console.error(
          "[auth/login][mfa-e6-canary] FAIL_OPEN_TO_LEGACY",
          mfaError
        );
        await observeShadow();
      }
    } else if (e6Runtime.mode === "SHADOW") {
      await observeShadow();
    }

    const token = signSessionBoundAuthToken(
      {
        sub: user.id,
        orgId: user.organizationId,
        email: user.email,
        role: user.role,
        tokenVersion: user.tokenVersion,
      },
      boundSessionId
    );

    await prisma.dashboardUser.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    res.setHeader(
      "Set-Cookie",
      buildAuthCookie(token, {
        requestOrigin: req.get("origin"),
      })
    );

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
    });
  } catch (e) {
    console.error("[auth/login] ERROR", e);
    return res.status(500).json({ error: "LOGIN_FAILED" });
  }
});

// =======================
// LOGOUT
// =======================
authRouter.post("/auth/logout", async (req, res) => {
  const token = extractTokenFromRequest(req);

  res.setHeader(
    "Set-Cookie",
    buildClearAuthCookie({
      requestOrigin: req.get("origin"),
    })
  );

  if (token) {
    try {
      const payload = verifySessionBoundAuthToken(token);
      await revokeBoundSessionOnLogout(prisma as any, {
        sessionId: payload.sid,
        userId: payload.sub,
        organizationId: payload.orgId,
        tokenVersion: payload.tokenVersion,
        userAgent: req.get("user-agent") ?? null,
      });
    } catch (logoutSessionError) {
      console.error(
        "[auth/logout][session-e8a] REVOCATION_FAILED",
        logoutSessionError
      );
    }
  }

  return res.json({ ok: true });
});

// =======================
// ME (SESSION CHECK)
// =======================
authRouter.get("/auth/me", async (req, res) => {
  try {
    const token = extractTokenFromRequest(req);

    if (!token) {
      return res.status(401).json({ error: "UNAUTHENTICATED" });
    }

    let payload: ReturnType<typeof verifySessionBoundAuthToken>;

    try {
      payload = verifySessionBoundAuthToken(token);
    } catch {
      res.setHeader(
        "Set-Cookie",
        buildClearAuthCookie({
          requestOrigin: req.get("origin"),
        })
      );
      return res.status(401).json({ error: "INVALID_TOKEN" });
    }

    const user = await prisma.dashboardUser.findUnique({
      where: { id: payload.sub },
      select: {
        id: true,
        organizationId: true,
        email: true,
        role: true,
        isActive: true,
        tokenVersion: true,
        organization: {
          select: {
            name: true,
            slug: true,
          },
        },
      },
    });

    if (!user) {
      res.setHeader(
        "Set-Cookie",
        buildClearAuthCookie({
          requestOrigin: req.get("origin"),
        })
      );
      return res.status(401).json({ error: "USER_NOT_FOUND" });
    }

    if (!user.isActive) {
      return res.status(403).json({ error: "USER_DISABLED" });
    }

    if (user.tokenVersion !== payload.tokenVersion) {
      res.setHeader(
        "Set-Cookie",
        buildClearAuthCookie({
          requestOrigin: req.get("origin"),
        })
      );
      return res.status(401).json({ error: "SESSION_EXPIRED" });
    }

    try {
      const observation = await observeSessionBindingShadow(prisma as any, {
        sessionId: payload.sid,
        userId: payload.sub,
        organizationId: payload.orgId,
        tokenVersion: payload.tokenVersion,
      });

      if (observation.bound && !observation.valid) {
        console.warn("[auth/me][session-e8a-shadow] WOULD_DENY", {
          sessionId: observation.sessionId,
          reason: observation.reason,
        });
      }
    } catch (shadowError) {
      console.error(
        "[auth/me][session-e8a-shadow] OBSERVATION_FAILED",
        shadowError
      );
    }

    return res.json({
      user: {
        id: user.id,
        email: user.email,
        orgId: user.organizationId,
        role: user.role,
        organizationName: user.organization?.name ?? null,
        organizationSlug: user.organization?.slug ?? null,
      },
    });
  } catch (e) {
    console.error("[auth/me] ERROR", e);
    return res.status(401).json({ error: "UNAUTHENTICATED" });
  }
});

// =======================
// PASSWORD FLOWS
// =======================
authRouter.post("/auth/forgot-password", forgotPasswordHandler);
authRouter.post("/auth/reset-password", resetPasswordHandler);
authRouter.post(
  "/auth/forgot-password/verify-code",
  verifyForgotPasswordCodeHandler
);

// =======================
// REGISTER ORG
// =======================
authRouter.post("/api/auth/register-organization", async (req, res) => {
  try {
    const organizationName = String(req.body?.organizationName ?? "").trim();
    const email = String(req.body?.email ?? "").trim().toLowerCase();
    const password = String(req.body?.password ?? "");
    const fullName = String(req.body?.name ?? "").trim();

    const role =
      String(req.body?.role ?? "ADMIN").toUpperCase() === "MEMBER"
        ? "MEMBER"
        : "ADMIN";

    if (!organizationName || !email || !password || !fullName) {
      return res.status(400).json({
        ok: false,
        error: "ORGANIZATION_NAME_EMAIL_PASSWORD_NAME_REQUIRED",
      });
    }

    const passwordPolicy = validatePasswordPolicy(password, {
      email,
      fullName,
      organizationName,
    });

    if (!passwordPolicy.ok) {
      return res.status(400).json({
        ok: false,
        error: "WEAK_PASSWORD",
        details: passwordPolicy.errors,
      });
    }

    const existingUser = await prisma.dashboardUser.findUnique({
      where: { email },
      select: { id: true },
    });

    if (existingUser) {
      return res.status(409).json({
        ok: false,
        error: "EMAIL_ALREADY_REGISTERED",
      });
    }

    const passwordHash = await hashPassword(password);

    const created = await prisma.organization.create({
      data: {
        name: organizationName,
        dashboardUsers: {
          create: {
            email,
            passwordHash,
            fullName,
            role,
            isActive: true,
            tokenVersion: 1,
          },
        },
      },
      include: {
        dashboardUsers: {
          select: {
            id: true,
            organizationId: true,
            email: true,
            fullName: true,
            role: true,
            isActive: true,
            tokenVersion: true,
          },
        },
      },
    });

    const createdUser = created.dashboardUsers[0];

    if (!createdUser) {
      throw new Error("REGISTERED_USER_MISSING");
    }

    return res.status(201).json({
      ok: true,
      requiresLogin: true,
      organization: {
        id: created.id,
        name: created.name,
      },
      user: {
        id: createdUser.id,
        email: createdUser.email,
        fullName: createdUser.fullName,
        orgId: createdUser.organizationId,
        role: createdUser.role,
        organizationName: created.name,
      },
    });
  } catch (e: any) {
    console.error("[auth/register-organization] ERROR", e);

    return res.status(500).json({
      ok: false,
      error: e?.message ?? "REGISTER_ORGANIZATION_FAILED",
    });
  }
});