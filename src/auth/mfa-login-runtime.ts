import { hashOpaqueToken } from "./mfa-core.js";
import { createAuthSession } from "./trusted-device-session.persistence.js";

export type E5RuntimeMode = "OFF" | "SHADOW";

export type E5RuntimeResolution = {
  mode: E5RuntimeMode;
  enforceBlocked: boolean;
  source: "DEFAULT" | "CONFIGURED" | "INVALID";
};

export type E5ShadowObservation = {
  sessionId: string | null;
  trustedDeviceId: string | null;
  trustedDeviceValid: boolean;
  hasVerifiedEmailFactor: boolean;
  wouldRequireEmailOtp: boolean;
};

export type E5LoginRuntimeClient = {
  authFactor: {
    findFirst(args: unknown): Promise<{ id: string } | null>;
  };
  trustedDevice: {
    findFirst(args: unknown): Promise<{ id: string } | null>;
    update(args: unknown): Promise<unknown>;
  };
  authSession: {
    create(args: unknown): Promise<{ id: string }>;
  };
  securityEvent: {
    create(args: unknown): Promise<unknown>;
  };
};

export function resolveE5RuntimeMode(value: unknown): E5RuntimeResolution {
  const normalized = String(value ?? "").trim().toUpperCase();

  if (!normalized || normalized === "OFF") {
    return {
      mode: "OFF",
      enforceBlocked: false,
      source: normalized ? "CONFIGURED" : "DEFAULT",
    };
  }

  if (normalized === "SHADOW") {
    return { mode: "SHADOW", enforceBlocked: false, source: "CONFIGURED" };
  }

  if (normalized === "ENFORCE") {
    return { mode: "OFF", enforceBlocked: true, source: "CONFIGURED" };
  }

  return { mode: "OFF", enforceBlocked: false, source: "INVALID" };
}

function cleanOptional(value: string | null | undefined): string | null {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

export async function observeE5ShadowLogin(
  client: E5LoginRuntimeClient,
  input: {
    userId: string;
    organizationId: string;
    email: string;
    tokenVersion: number;
    trustedDeviceToken?: string | null;
    userAgent?: string | null;
    ipHash?: string | null;
    now?: Date;
  }
): Promise<E5ShadowObservation> {
  const now = input.now ?? new Date();
  const trustedToken = String(input.trustedDeviceToken ?? "").trim();

  const [verifiedEmailFactor, trustedDevice] = await Promise.all([
    client.authFactor.findFirst({
      where: {
        userId: input.userId,
        type: "EMAIL",
        status: "VERIFIED",
        destination: input.email.toLowerCase(),
      },
      select: { id: true },
    }),
    trustedToken
      ? client.trustedDevice.findFirst({
          where: {
            userId: input.userId,
            tokenHash: hashOpaqueToken(trustedToken),
            revokedAt: null,
            expiresAt: { gt: now },
          },
          select: { id: true },
        })
      : Promise.resolve(null),
  ]);

  if (trustedDevice) {
    await client.trustedDevice.update({
      where: { id: trustedDevice.id },
      data: { lastUsedAt: now },
    });
  }

  const session = await createAuthSession(client as any, {
    userId: input.userId,
    organizationId: input.organizationId,
    tokenVersion: input.tokenVersion,
    trustedDeviceId: trustedDevice?.id ?? null,
    userAgent: cleanOptional(input.userAgent),
    lastIpHash: cleanOptional(input.ipHash),
    now,
  });

  const hasVerifiedEmailFactor = Boolean(verifiedEmailFactor);
  const trustedDeviceValid = Boolean(trustedDevice);
  const wouldRequireEmailOtp = !trustedDeviceValid;

  await client.securityEvent.create({
    data: {
      userId: input.userId,
      organizationId: input.organizationId,
      type: "AUTH_SESSION_CREATED",
      ipHash: cleanOptional(input.ipHash),
      userAgent: cleanOptional(input.userAgent),
      metadata: {
        mode: "SHADOW",
        sessionId: session.sessionId,
        trustedDeviceValid,
        hasVerifiedEmailFactor,
        wouldRequireEmailOtp,
      },
    },
  });

  return {
    sessionId: session.sessionId,
    trustedDeviceId: trustedDevice?.id ?? null,
    trustedDeviceValid,
    hasVerifiedEmailFactor,
    wouldRequireEmailOtp,
  };
}
