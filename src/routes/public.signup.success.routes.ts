import { Router } from "express";
import { PrismaClient, PendingSignupStatus } from "@prisma/client";

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
            dashboardUsers: {
              select: { id: true },
            },
          },
        },
      },
    });

    if (!pending) {
      return res.json({ ok: false });
    }

    if (pending.status !== PendingSignupStatus.COMPLETED || !pending.organizationId) {
      return res.json({
        ok: true,
        ready: false,
        autoLoggedIn: false,
        requiresLogin: false,
        status: pending.status,
      });
    }

    const user = pending.organization?.dashboardUsers?.[0];

    if (!user) {
      return res.json({
        ok: true,
        ready: false,
        autoLoggedIn: false,
        requiresLogin: false,
        status: "USER_PENDING",
      });
    }

    return res.json({
      ok: true,
      ready: true,
      autoLoggedIn: false,
      requiresLogin: true,
    });
  } catch (e) {
    console.error("[SIGNUP_SUCCESS_STATUS_ERROR]", e);

    return res.json({
      ok: false,
      error: "internal_error",
    });
  }
});
