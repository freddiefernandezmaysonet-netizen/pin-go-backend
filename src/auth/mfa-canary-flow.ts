import { hashOpaqueToken } from "./mfa-core.js";
import {
  MFA_OTP_RESEND_COOLDOWN_MS,
  canResendOtp,
  createOtpMaterial,
  otpExpiresAt,
} from "./mfa-otp.js";
import {
  deliverMfaEmailOtp,
  type MfaEmailDeliveryEnvironment,
  type MfaEmailSender,
} from "./mfa-email-otp-delivery.js";
import { createLoginEmailMfaChallenge } from "./mfa-login-challenge.js";
import { normalizeMfaEmail } from "./mfa-email-only-policy.js";

export type E6CanaryFlowClient = {
  authFactor: {
    upsert(args: unknown): Promise<{ id: string; status: string }>;
    findUnique(args: unknown): Promise<{ id: string; destination: string | null } | null>;
    update(args: unknown): Promise<unknown>;
  };
  mfaChallenge: {
    create(args: unknown): Promise<{ id: string }>;
    findUnique(args: unknown): Promise<{
      id: string;
      userId: string;
      factorId: string;
      status: string;
      expiresAt: Date;
      lastSentAt: Date | null;
      attemptCount: number;
      maxAttempts: number;
      consumedAt: Date | null;
      otpHash: string;
    } | null>;
    update(args: unknown): Promise<unknown>;
  };
  securityEvent: {
    create(args: unknown): Promise<unknown>;
  };
};

export type E6DeliveryOptions = {
  env?: MfaEmailDeliveryEnvironment;
  sender?: MfaEmailSender;
};

export type BeginCanaryResult = {
  challengeToken: string;
  expiresAt: Date;
  maskedDestination: string;
  delivered: boolean;
};

function maskEmail(email: string): string {
  const normalized = normalizeMfaEmail(email);
  const at = normalized.indexOf("@");
  const local = normalized.slice(0, at);
  const domain = normalized.slice(at + 1);
  const visible = local.slice(0, Math.min(1, local.length));
  return `${visible}${"•".repeat(Math.max(3, local.length - visible.length))}@${domain}`;
}

export async function beginE6EmailCanary(
  client: E6CanaryFlowClient,
  input: {
    userId: string;
    organizationId: string;
    email: string;
    pepper: string;
    now?: Date;
  },
  deliveryOptions: E6DeliveryOptions = {}
): Promise<BeginCanaryResult> {
  const now = input.now ?? new Date();
  const created = await createLoginEmailMfaChallenge(client, {
    userId: input.userId,
    organizationId: input.organizationId,
    email: input.email,
    pepper: input.pepper,
    now,
  });

  const delivery = await deliverMfaEmailOtp(
    {
      destination: input.email,
      code: created.code,
      expiresInMinutes: 5,
    },
    deliveryOptions
  );

  if (!delivery.delivered) {
    throw new Error("MFA_CANARY_EMAIL_NOT_DELIVERED");
  }

  await client.securityEvent.create({
    data: {
      userId: input.userId,
      organizationId: input.organizationId,
      type: "MFA_CHALLENGE_SENT",
      metadata: {
        challengeId: created.challengeId,
        provider: delivery.mode,
        providerMessageId: delivery.providerMessageId,
      },
    },
  });

  return {
    challengeToken: created.challengeToken,
    expiresAt: created.expiresAt,
    maskedDestination: maskEmail(input.email),
    delivered: true,
  };
}

export type ResendCanaryResult =
  | {
      ok: true;
      expiresAt: Date;
      maskedDestination: string;
      cooldownSeconds: number;
    }
  | {
      ok: false;
      reason: "NOT_FOUND" | "NOT_PENDING" | "COOLDOWN" | "EXPIRED";
      retryAfterSeconds?: number;
    };

export async function resendE6EmailCanary(
  client: E6CanaryFlowClient,
  input: {
    challengeToken: string;
    organizationId: string;
    pepper: string;
    now?: Date;
  },
  deliveryOptions: E6DeliveryOptions = {}
): Promise<ResendCanaryResult> {
  const now = input.now ?? new Date();
  const token = String(input.challengeToken ?? "").trim();
  if (!token) return { ok: false, reason: "NOT_FOUND" };

  const challenge = await client.mfaChallenge.findUnique({
    where: { challengeTokenHash: hashOpaqueToken(token) },
    select: {
      id: true,
      userId: true,
      factorId: true,
      status: true,
      expiresAt: true,
      lastSentAt: true,
      attemptCount: true,
      maxAttempts: true,
      consumedAt: true,
      otpHash: true,
    },
  });

  if (!challenge) return { ok: false, reason: "NOT_FOUND" };
  if (challenge.status !== "PENDING" || challenge.consumedAt) {
    return { ok: false, reason: "NOT_PENDING" };
  }
  if (challenge.expiresAt.getTime() <= now.getTime()) {
    await client.mfaChallenge.update({
      where: { id: challenge.id },
      data: { status: "EXPIRED" },
    });
    return { ok: false, reason: "EXPIRED" };
  }

  if (!canResendOtp(challenge.lastSentAt, now)) {
    const last = challenge.lastSentAt?.getTime() ?? now.getTime();
    const remainingMs = Math.max(
      0,
      MFA_OTP_RESEND_COOLDOWN_MS - (now.getTime() - last)
    );
    return {
      ok: false,
      reason: "COOLDOWN",
      retryAfterSeconds: Math.ceil(remainingMs / 1000),
    };
  }

  const factor = await client.authFactor.findUnique({
    where: { id: challenge.factorId },
    select: { id: true, destination: true },
  });
  const destination = factor?.destination
    ? normalizeMfaEmail(factor.destination)
    : null;
  if (!destination) return { ok: false, reason: "NOT_FOUND" };

  const material = createOtpMaterial({
    challengeId: challenge.id,
    pepper: input.pepper,
  });
  const expiresAt = otpExpiresAt(now);

  const delivery = await deliverMfaEmailOtp(
    {
      destination,
      code: material.code,
      expiresInMinutes: 5,
    },
    deliveryOptions
  );
  if (!delivery.delivered) throw new Error("MFA_CANARY_EMAIL_NOT_DELIVERED");

  await client.mfaChallenge.update({
    where: { id: challenge.id },
    data: {
      otpHash: material.otpHash,
      expiresAt,
      lastSentAt: now,
      attemptCount: 0,
      status: "PENDING",
    },
  });

  await client.securityEvent.create({
    data: {
      userId: challenge.userId,
      organizationId: input.organizationId,
      type: "MFA_CHALLENGE_SENT",
      metadata: {
        challengeId: challenge.id,
        resend: true,
        provider: delivery.mode,
        providerMessageId: delivery.providerMessageId,
      },
    },
  });

  return {
    ok: true,
    expiresAt,
    maskedDestination: maskEmail(destination),
    cooldownSeconds: Math.ceil(MFA_OTP_RESEND_COOLDOWN_MS / 1000),
  };
}
