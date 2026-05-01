import { Router } from "express";
import { PrismaClient, PendingSignupStatus } from "@prisma/client";
import { signAuthToken, buildAuthCookie } from "../lib/auth";

const prisma = new PrismaClient();
export const signupSuccessRouter = Router();

signupSuccessRouter.get("/api/public/signup-success-status", async (req, res) => {
  try {
    const sessionId = String(req.query.session_id ?? "");

    if (!sessionId) {
      return res.json({ ok: false });
    }

    const pending = await prisma.pendingSignup.findFirst({
      where: {
        stripeCheckoutSessionId: sessionId,
      },
      include: {
        organization: {
          include: {
            dashboardUsers: true,
          },
        },
      },
    });

    if (!pending) {
      return res.json({ ok: false });
    }

    // ⏳ Aún no listo
    if (pending.status !== PendingSignupStatus.COMPLETED || !pending.organizationId) {
      return res.json({
        ok: true,
        ready: false,
        autoLoggedIn: false,
        status: pending.status,
      });
    }

    const user = pending.organization?.dashboardUsers?.[0];

    if (!user) {
      return res.json({
        ok: true,
        ready: true,
        autoLoggedIn: false,
      });
    }

    // 🔐 AUTO LOGIN
    const token = signAuthToken({
      sub: user.id,
      orgId: user.organizationId,
      email: user.email,
      role: user.role,
      tokenVersion: user.tokenVersion,
    });

    res.setHeader("Set-Cookie", buildAuthCookie(token));

    return res.json({
      ok: true,
      ready: true,
      autoLoggedIn: true,
    });
  } catch (e) {
    console.error("[SIGNUP_SUCCESS_STATUS_ERROR]", e);

    return res.json({
      ok: false,
      error: "internal_error",
    });
  }
});