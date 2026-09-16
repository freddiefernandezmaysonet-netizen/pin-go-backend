import { generateOpaqueToken, hashOpaqueToken } from "./mfa-core.js";
import {
  SESSION_ABSOLUTE_TIMEOUT_MS,
  trustedDeviceExpiresAt,
} from "./session-security.policy.js";

export type TrustedDeviceCreateData = {
  userId: string;
  tokenHash: string;
  label?: string | null;
  userAgent?: string | null;
  lastIpHash?: string | null;
  expiresAt: Date;
};

export type AuthSessionCreateData = {
  userId: string;
  organizationId: string;
  tokenVersion: number;
  authenticatedAt: Date;
  lastActivityAt: Date;
  absoluteExpiresAt: Date;
  trustedDeviceId?: string | null;
  userAgent?: string | null;
  lastIpHash?: string | null;
};

export type TrustedDeviceSessionClient = {
  trustedDevice: {
    create(args: { data: TrustedDeviceCreateData }): Promise<{ id: string }>;
  };
  authSession: {
    create(args: { data: AuthSessionCreateData }): Promise<{ id: string }>;
  };
};

function cleanOptional(value: string | null | undefined): string | null {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

export function authSessionAbsoluteExpiresAt(authenticatedAt = new Date()): Date {
  return new Date(authenticatedAt.getTime() + SESSION_ABSOLUTE_TIMEOUT_MS);
}

export async function createTrustedDevice(
  client: TrustedDeviceSessionClient,
  input: {
    userId: string;
    label?: string | null;
    userAgent?: string | null;
    lastIpHash?: string | null;
    now?: Date;
  }
): Promise<{ trustedDeviceId: string; token: string; expiresAt: Date }> {
  const userId = String(input.userId ?? "").trim();
  if (!userId) throw new Error("TRUSTED_DEVICE_USER_REQUIRED");

  const now = input.now ?? new Date();
  const token = generateOpaqueToken(32);
  const expiresAt = trustedDeviceExpiresAt(now);

  const row = await client.trustedDevice.create({
    data: {
      userId,
      tokenHash: hashOpaqueToken(token),
      label: cleanOptional(input.label),
      userAgent: cleanOptional(input.userAgent),
      lastIpHash: cleanOptional(input.lastIpHash),
      expiresAt,
    },
  });

  return {
    trustedDeviceId: row.id,
    token,
    expiresAt,
  };
}

export async function createAuthSession(
  client: TrustedDeviceSessionClient,
  input: {
    userId: string;
    organizationId: string;
    tokenVersion: number;
    trustedDeviceId?: string | null;
    userAgent?: string | null;
    lastIpHash?: string | null;
    now?: Date;
  }
): Promise<{ sessionId: string; absoluteExpiresAt: Date }> {
  const userId = String(input.userId ?? "").trim();
  const organizationId = String(input.organizationId ?? "").trim();
  if (!userId) throw new Error("AUTH_SESSION_USER_REQUIRED");
  if (!organizationId) throw new Error("AUTH_SESSION_ORGANIZATION_REQUIRED");
  if (!Number.isInteger(input.tokenVersion) || input.tokenVersion < 0) {
    throw new Error("AUTH_SESSION_TOKEN_VERSION_INVALID");
  }

  const authenticatedAt = input.now ?? new Date();
  const absoluteExpiresAt = authSessionAbsoluteExpiresAt(authenticatedAt);

  const row = await client.authSession.create({
    data: {
      userId,
      organizationId,
      tokenVersion: input.tokenVersion,
      authenticatedAt,
      lastActivityAt: authenticatedAt,
      absoluteExpiresAt,
      trustedDeviceId: cleanOptional(input.trustedDeviceId),
      userAgent: cleanOptional(input.userAgent),
      lastIpHash: cleanOptional(input.lastIpHash),
    },
  });

  return { sessionId: row.id, absoluteExpiresAt };
}
