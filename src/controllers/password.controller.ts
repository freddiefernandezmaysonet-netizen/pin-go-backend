import type { Request, Response } from "express";
import { PrismaClient } from "@prisma/client";
import {
  generateResetToken,
  getResetTokenExpiry,
  hashResetToken,
} from "../lib/passwordReset";
import { validatePasswordPolicy } from "../lib/passwordPolicy";
import { hashPassword } from "../lib/auth";
import { sendResetPasswordEmail } from "../lib/mailer";

const prisma = new PrismaClient();

function getPasswordResetUrl(token: string) {
  const explicitResetUrl = String(process.env.PASSWORD_RESET_URL ?? "").trim();
  const frontendOrigin = String(process.env.FRONTEND_ORIGIN ?? "").trim();

  if (explicitResetUrl) {
    return `${explicitResetUrl}?token=${encodeURIComponent(token)}`;
  }

  if (frontendOrigin) {
    return `${frontendOrigin}/reset-password?token=${encodeURIComponent(token)}`;
  }

  if (process.env.NODE_ENV !== "production") {
    return `http://localhost:5173/reset-password?token=${encodeURIComponent(token)}`;
  }

  throw new Error("Missing PASSWORD_RESET_URL or FRONTEND_ORIGIN");
}

export async function forgotPasswordHandler(req: Request, res: Response) {
  try {
    const email = String(req.body?.email ?? "").trim().toLowerCase();

    const safeResponse = {
      ok: true,
      message: "If the account exists, a reset link has been sent.",
    };

    if (!email) {
      return res.json(safeResponse);
    }

    const user = await prisma.dashboardUser.findUnique({
      where: { email },
    });

    if (!user) {
      return res.json(safeResponse);
    }

    await prisma.passwordResetToken.deleteMany({
      where: {
        userId: user.id,
        usedAt: null,
      },
    });

    const token = generateResetToken();
    const tokenHash = hashResetToken(token);
    const expiresAt = getResetTokenExpiry(45);

    await prisma.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash,
        expiresAt,
      },
    });

    const resetUrl = getPasswordResetUrl(token);

    await sendResetPasswordEmail({
      to: user.email,
      resetUrl,
    });

    return res.json(safeResponse);
  } catch (error) {
    console.error("[auth/forgot-password] ERROR", error);
    return res.status(500).json({
      ok: false,
      error: "FORGOT_PASSWORD_FAILED",
    });
  }
}

export async function resetPasswordHandler(req: Request, res: Response) {
  try {
    const token = String(req.body?.token ?? "").trim();
    const password = String(req.body?.password ?? "");

    if (!token || !password) {
      return res.status(400).json({
        ok: false,
        error: "MISSING_TOKEN_OR_PASSWORD",
      });
    }

    const tokenHash = hashResetToken(token);

    const resetRecord = await prisma.passwordResetToken.findUnique({
      where: { tokenHash },
      include: {
        user: true,
      },
    });

    if (
      !resetRecord ||
      resetRecord.usedAt ||
      resetRecord.expiresAt < new Date()
    ) {
      return res.status(400).json({
        ok: false,
        error: "INVALID_OR_EXPIRED_TOKEN",
      });
    }

    const policy = validatePasswordPolicy(password, {
      email: resetRecord.user.email,
      fullName: resetRecord.user.fullName,
    });

    if (!policy.ok) {
      return res.status(400).json({
        ok: false,
        error: "WEAK_PASSWORD",
        details: policy.errors,
      });
    }

    const passwordHash = await hashPassword(password);

    await prisma.$transaction([
      prisma.dashboardUser.update({
        where: { id: resetRecord.userId },
        data: {
          passwordHash,
          tokenVersion: {
            increment: 1,
          },
        },
      }),
      prisma.passwordResetToken.update({
        where: { id: resetRecord.id },
        data: { usedAt: new Date() },
      }),
      prisma.passwordResetToken.deleteMany({
        where: {
          userId: resetRecord.userId,
          usedAt: null,
          id: { not: resetRecord.id },
        },
      }),
    ]);

    return res.json({
      ok: true,
      message: "Password updated",
    });
  } catch (error) {
    console.error("[auth/reset-password] ERROR", error);
    return res.status(500).json({
      ok: false,
      error: "RESET_PASSWORD_FAILED",
    });
  }
}