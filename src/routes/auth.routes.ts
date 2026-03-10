import { Router } from "express";
import { PrismaClient } from "@prisma/client";
import {
  comparePassword,
  signAuthToken,
  buildAuthCookie,
  buildClearAuthCookie,
  extractTokenFromRequest,
  verifyAuthToken,
} from "../lib/auth";

const prisma = new PrismaClient();
export const authRouter = Router();

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
    });

    await prisma.dashboardUser.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    res.setHeader("Set-Cookie", buildAuthCookie(token));

    return res.json({
      ok: true,
      user: {
        id: user.id,
        email: user.email,
        orgId: user.organizationId,
        role: user.role,
      },
    });
  } catch (e) {
    console.error("[auth/login] ERROR", e);
    return res.status(500).json({ error: "LOGIN_FAILED" });
  }
});

authRouter.post("/auth/logout", async (_req, res) => {
  res.setHeader("Set-Cookie", buildClearAuthCookie());
  return res.json({ ok: true });
});

authRouter.get("/auth/me", async (req, res) => {
  try {
    const token = extractTokenFromRequest(req);

    if (!token) {
      return res.status(401).json({ error: "UNAUTHENTICATED" });
    }

    const payload = verifyAuthToken(token);

    const user = await prisma.dashboardUser.findUnique({
      where: { id: payload.sub },
      select: {
        id: true,
        organizationId: true,
        email: true,
        role: true,
        isActive: true,
      },
    });

    if (!user) {
      return res.status(401).json({ error: "USER_NOT_FOUND" });
    }

    if (!user.isActive) {
      return res.status(403).json({ error: "USER_DISABLED" });
    }

    return res.json({
      user: {
        id: user.id,
        email: user.email,
        orgId: user.organizationId,
        role: user.role,
      },
    });
  } catch {
    return res.status(401).json({ error: "UNAUTHENTICATED" });
  }
});