import { Router } from "express";
import { PrismaClient } from "@prisma/client";
import {
  comparePassword,
  signAuthToken,
  buildAuthCookie,
  buildClearAuthCookie,
  extractTokenFromRequest,
  verifyAuthToken,
  hashPassword,
} from "../lib/auth";
import { validatePasswordPolicy } from "../lib/passwordPolicy";
import {
  forgotPasswordHandler,
  resetPasswordHandler,
} from "../controllers/password.controller";

const prisma = new PrismaClient();
export const authRouter = Router();

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

    const token = signAuthToken({
      sub: user.id,
      orgId: user.organizationId,
      email: user.email,
      role: user.role,
      tokenVersion: user.tokenVersion,
    });

    await prisma.dashboardUser.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    // ✅ Cookie PRODUCTION READY
    res.setHeader("Set-Cookie", buildAuthCookie(token));

    return res.json({
      ok: true,
      user: {
        id: user.id,
        email: user.email,
        orgId: user.organizationId,
        role: user.role,
        organizationName: user.organization?.name ?? null,
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
authRouter.post("/auth/logout", async (_req, res) => {
  // ✅ Limpieza correcta de cookie
  res.setHeader("Set-Cookie", buildClearAuthCookie());
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

    let payload: any;

    try {
      payload = verifyAuthToken(token);
    } catch {
      res.setHeader("Set-Cookie", buildClearAuthCookie());
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
          },
        },
      },
    });

    if (!user) {
      res.setHeader("Set-Cookie", buildClearAuthCookie());
      return res.status(401).json({ error: "USER_NOT_FOUND" });
    }

    if (!user.isActive) {
      return res.status(403).json({ error: "USER_DISABLED" });
    }

    if (user.tokenVersion !== payload.tokenVersion) {
      res.setHeader("Set-Cookie", buildClearAuthCookie());
      return res.status(401).json({ error: "SESSION_EXPIRED" });
    }

    return res.json({
      user: {
        id: user.id,
        email: user.email,
        orgId: user.organizationId,
        role: user.role,
        organizationName: user.organization?.name ?? null,
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

    const token = signAuthToken({
      sub: createdUser.id,
      orgId: createdUser.organizationId,
      email: createdUser.email,
      role: createdUser.role,
      tokenVersion: createdUser.tokenVersion,
    });

    // ✅ Cookie consistente con login
    res.setHeader("Set-Cookie", buildAuthCookie(token));

    return res.status(201).json({
      ok: true,
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