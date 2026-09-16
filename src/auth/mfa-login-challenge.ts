import {
  generateOpaqueToken,
  hashOpaqueToken,
  isChallengeUsable,
  nextAttemptCount,
} from "./mfa-core.js";
import {
  MFA_OTP_MAX_ATTEMPTS,
  createOtpMaterial,
  otpExpiresAt,
  verifyOtpMaterial,
} from "./mfa-otp.js";
import { normalizeMfaEmail } from "./mfa-email-only-policy.js";

export type LoginMfaChallengeClient = {
  authFactor: {
    upsert(args: unknown): Promise<{ id: string; status: string }>;
    update(args: unknown): Promise<unknown>;
  };
  mfaChallenge: {
    create(args: unknown): Promise<{ id: string }>;
    findUnique(args: unknown): Promise<{
      id: string;
      userId: string;
      factorId: string;
      otpHash: string;
      status: string;
      attemptCount: number;
      maxAttempts: number;
      expiresAt: Date;
      consumedAt: Date | null;
    } | null>;
    update(args: unknown): Promise<unknown>;
  };
  securityEvent: {
    create(args: unknown): Promise<unknown>;
  };
};

function requirePepper(pepper: string): string {
  const value = String(pepper ?? "").trim();
  if (value.length < 32) throw new Error("MFA_OTP_PEPPER_MISSING");
  return value;
}

export async function createLoginEmailMfaChallenge(
  client: LoginMfaChallengeClient,
  input: {
    userId: string;
    organizationId: string;
    email: string;
    pepper: string;
    now?: Date;
  }
): Promise<{
  challengeId: string;
  challengeToken: string;
  code: string;
  expiresAt: Date;
  factorId: string;
}> {
  const now = input.now ?? new Date();
  const email = normalizeMfaEmail(input.email);
  const pepper = requirePepper(input.pepper);

  const factor = await client.authFactor.upsert({
    where: {
      userId_type_destination: {
        userId: input.userId,
        type: "EMAIL",
        destination: email,
      },
    },
    create: {
      userId: input.userId,
      type: "EMAIL",
      status: "PENDING",
      destination: email,
      label: "Primary email",
    },
    update: {},
    select: { id: true, status: true },
  });

  const challengeToken = generateOpaqueToken(32);
  const challengeTokenHash = hashOpaqueToken(challengeToken);
  const provisionalId = generateOpaqueToken(18);
  const material = createOtpMaterial({ challengeId: provisionalId, pepper });
  const expiresAt = otpExpiresAt(now);

  const challenge = await client.mfaChallenge.create({
    data: {
      id: provisionalId,
      userId: input.userId,
      factorId: factor.id,
      purpose: "LOGIN_MFA",
      challengeTokenHash,
      otpHash: material.otpHash,
      status: "PENDING",
      attemptCount: 0,
      maxAttempts: MFA_OTP_MAX_ATTEMPTS,
      expiresAt,
      lastSentAt: now,
    },
    select: { id: true },
  });

  await client.securityEvent.create({
    data: {
      userId: input.userId,
      organizationId: input.organizationId,
      type: "MFA_CHALLENGE_CREATED",
      metadata: {
        challengeId: challenge.id,
        factorType: "EMAIL",
        factorStatus: factor.status,
      },
    },
  });

  return {
    challengeId: challenge.id,
    challengeToken,
    code: material.code,
    expiresAt,
    factorId: factor.id,
  };
}

export type VerifyLoginEmailMfaResult =
  | { ok: true; userId: string; factorId: string }
  | { ok: false; reason: "NOT_FOUND" | "EXPIRED" | "LOCKED" | "INVALID_CODE" };

export async function verifyLoginEmailMfaChallenge(
  client: LoginMfaChallengeClient,
  input: {
    challengeToken: string;
    code: string;
    pepper: string;
    now?: Date;
  }
): Promise<VerifyLoginEmailMfaResult> {
  const now = input.now ?? new Date();
  const pepper = requirePepper(input.pepper);
  const challengeToken = String(input.challengeToken ?? "").trim();
  if (!challengeToken) return { ok: false, reason: "NOT_FOUND" };

  const challenge = await client.mfaChallenge.findUnique({
    where: { challengeTokenHash: hashOpaqueToken(challengeToken) },
    select: {
      id: true,
      userId: true,
      factorId: true,
      otpHash: true,
      status: true,
      attemptCount: true,
      maxAttempts: true,
      expiresAt: true,
      consumedAt: true,
    },
  });

  if (!challenge) return { ok: false, reason: "NOT_FOUND" };

  if (!isChallengeUsable(challenge, now) || challenge.status !== "PENDING") {
    const reason =
      challenge.expiresAt.getTime() <= now.getTime()
        ? "EXPIRED"
        : "LOCKED";
    await client.mfaChallenge.update({
      where: { id: challenge.id },
      data: { status: reason === "EXPIRED" ? "EXPIRED" : "LOCKED" },
    });
    return { ok: false, reason };
  }

  const valid = verifyOtpMaterial({
    challengeId: challenge.id,
    pepper,
    code: input.code,
    otpHash: challenge.otpHash,
  });

  if (!valid) {
    const attemptCount = nextAttemptCount(challenge);
    const locked = attemptCount >= challenge.maxAttempts;
    await client.mfaChallenge.update({
      where: { id: challenge.id },
      data: {
        attemptCount,
        status: locked ? "LOCKED" : "PENDING",
      },
    });
    return { ok: false, reason: locked ? "LOCKED" : "INVALID_CODE" };
  }

  await client.mfaChallenge.update({
    where: { id: challenge.id },
    data: {
      status: "CONSUMED",
      verifiedAt: now,
      consumedAt: now,
    },
  });

  await client.authFactor.update({
    where: { id: challenge.factorId },
    data: {
      status: "VERIFIED",
      verifiedAt: now,
      lastUsedAt: now,
    },
  });

  return { ok: true, userId: challenge.userId, factorId: challenge.factorId };
}
