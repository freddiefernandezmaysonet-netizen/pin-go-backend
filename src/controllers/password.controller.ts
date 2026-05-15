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
import { sendGuestSms } from "../services/sms.service";

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

function generateNumericCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function getSmsCodeExpiry(minutes = 10) {
  return new Date(Date.now() + minutes * 60 * 1000);
}

function getSafeForgotPasswordResponse() {
  return {
    ok: true,
    message: "If the account exists, a reset code has been sent.",
  };
}

async function createAndSendResetEmail(user: {
  id: string;
  email: string;
}) {
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
}

export async function forgotPasswordHandler(req: Request, res: Response) {
  try {
    const email = String(req.body?.email ?? "").trim().toLowerCase();
    const safeResponse = getSafeForgotPasswordResponse();

    if (!email) {
      return res.json(safeResponse);
    }

    const user = await prisma.dashboardUser.findUnique({
      where: { email },
      select: {
        id: true,
        email: true,
      },
    });

    if (!user) {
      return res.json(safeResponse);
    }

    const pendingSignup = await prisma.pendingSignup.findFirst({
      where: { email },
      orderBy: { createdAt: "desc" },
      select: {
        phone: true,
      },
    });

   function normalizePhoneToE164(phone: string) {
  const digits = String(phone ?? "").replace(/\D/g, "");

  // PR/US local number
  if (digits.length === 10) {
    return `+1${digits}`;
  }

  // already includes country code
  if (digits.length === 11 && digits.startsWith("1")) {
    return `+${digits}`;
  }

  // already E.164
  if (String(phone).startsWith("+")) {
    return String(phone).trim();
  }

  return null;
}

const rawPhone = String(pendingSignup?.phone ?? "").trim();
const phone = normalizePhoneToE164(rawPhone);

if (!phone) {

      console.warn("[auth/forgot-password] No phone found for user", {
        userId: user.id,
        email: user.email,
      });

      return res.json(safeResponse);
    }

    await prisma.passwordResetSmsCode.deleteMany({
      where: {
        userId: user.id,
        usedAt: null,
      },
    });

    const code = generateNumericCode();
    const codeHash = hashResetToken(code);

    await prisma.passwordResetSmsCode.create({
      data: {
        userId: user.id,
        phone,
        codeHash,
        expiresAt: getSmsCodeExpiry(10),
      },
    });

console.log("[auth/forgot-password] about to send SMS OTP", {
  userId: user.id,
  phone,
});

    await sendGuestSms(
      phone,
      `Your Pin&Go password reset code is ${code}. This code expires in 10 minutes.`
    );

console.log("[auth/forgot-password] SMS OTP sent");

    return res.json(safeResponse);
  } catch (error) {
    console.error("[auth/forgot-password] ERROR", error);
    return res.status(500).json({
      ok: false,
      error: "FORGOT_PASSWORD_FAILED",
    });
  }
}

export async function verifyForgotPasswordCodeHandler(
  req: Request,
  res: Response
) {
  try {
    const email = String(req.body?.email ?? "").trim().toLowerCase();
    const code = String(req.body?.code ?? "").trim();

    if (!email || !code) {
      return res.status(400).json({
        ok: false,
        error: "EMAIL_AND_CODE_REQUIRED",
      });
    }

    if (!/^\d{6}$/.test(code)) {
      return res.status(400).json({
        ok: false,
        error: "INVALID_CODE_FORMAT",
      });
    }

    const user = await prisma.dashboardUser.findUnique({
      where: { email },
      select: {
        id: true,
        email: true,
      },
    });

    if (!user) {
      return res.status(400).json({
        ok: false,
        error: "INVALID_OR_EXPIRED_CODE",
      });
    }

    const codeHash = hashResetToken(code);

    const resetCode = await prisma.passwordResetSmsCode.findFirst({
      where: {
        userId: user.id,
        codeHash,
        usedAt: null,
        expiresAt: {
          gt: new Date(),
        },
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    if (!resetCode) {
      return res.status(400).json({
        ok: false,
        error: "INVALID_OR_EXPIRED_CODE",
      });
    }

    await prisma.$transaction([
      prisma.passwordResetSmsCode.update({
        where: { id: resetCode.id },
        data: { usedAt: new Date() },
      }),
      prisma.passwordResetSmsCode.deleteMany({
        where: {
          userId: user.id,
          usedAt: null,
          id: { not: resetCode.id },
        },
      }),
    ]);

    await createAndSendResetEmail(user);

    return res.json({
      ok: true,
      message: "Code verified. Password reset email sent.",
    });
  } catch (error) {
    console.error("[auth/forgot-password/verify-code] ERROR", error);
    return res.status(500).json({
      ok: false,
      error: "VERIFY_FORGOT_PASSWORD_CODE_FAILED",
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