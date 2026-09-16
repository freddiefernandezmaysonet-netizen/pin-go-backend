import { evaluateSessionSecurity } from "./session-security.policy.js";

export const SESSION_HUMAN_ACTIVITY_TOUCH_INTERVAL_MS = 5 * 60 * 1000;

export type SessionEnforcementMode = "SHADOW" | "ENFORCE";

export type SessionInspectionReason =
  | "ACTIVE"
  | "UNBOUND_LEGACY"
  | "SESSION_NOT_FOUND"
  | "SESSION_REVOKED"
  | "SESSION_IDENTITY_MISMATCH"
  | "IDLE_TIMEOUT"
  | "ABSOLUTE_TIMEOUT"
  | "INVALID_TIMELINE";

export type SessionInspection = {
  bound: boolean;
  valid: boolean;
  sessionId: string | null;
  reason: SessionInspectionReason;
  authenticatedAt?: Date;
  lastActivityAt?: Date;
  absoluteExpiresAt?: Date;
};

type AuthSessionRow = {
  id: string;
  userId: string;
  organizationId: string;
  tokenVersion: number;
  authenticatedAt: Date;
  lastActivityAt: Date;
  absoluteExpiresAt: Date;
  revokedAt: Date | null;
};

export type SessionEnforcementClient = {
  authSession: {
    findUnique(args: unknown): Promise<AuthSessionRow | null>;
    updateMany(args: unknown): Promise<{ count: number }>;
  };
  securityEvent: {
    create(args: unknown): Promise<unknown>;
  };
};

export function resolveSessionEnforcementMode(
  rawMode = process.env.PINGO_SESSION_MODE
): SessionEnforcementMode {
  return String(rawMode ?? "").trim().toUpperCase() === "ENFORCE"
    ? "ENFORCE"
    : "SHADOW";
}

export function isSessionExpirationReason(
  reason: SessionInspectionReason
): reason is "IDLE_TIMEOUT" | "ABSOLUTE_TIMEOUT" | "INVALID_TIMELINE" {
  return (
    reason === "IDLE_TIMEOUT" ||
    reason === "ABSOLUTE_TIMEOUT" ||
    reason === "INVALID_TIMELINE"
  );
}

export async function inspectBoundSession(
  client: SessionEnforcementClient,
  input: {
    sessionId?: string | null;
    userId: string;
    organizationId: string;
    tokenVersion: number;
    now?: Date;
  }
): Promise<SessionInspection> {
  const sessionId = String(input.sessionId ?? "").trim();
  if (!sessionId) {
    return {
      bound: false,
      valid: false,
      sessionId: null,
      reason: "UNBOUND_LEGACY",
    };
  }

  const row = await client.authSession.findUnique({
    where: { id: sessionId },
    select: {
      id: true,
      userId: true,
      organizationId: true,
      tokenVersion: true,
      authenticatedAt: true,
      lastActivityAt: true,
      absoluteExpiresAt: true,
      revokedAt: true,
    },
  });

  if (!row) {
    return {
      bound: true,
      valid: false,
      sessionId,
      reason: "SESSION_NOT_FOUND",
    };
  }

  if (row.revokedAt) {
    return {
      bound: true,
      valid: false,
      sessionId,
      reason: "SESSION_REVOKED",
    };
  }

  if (
    row.userId !== input.userId ||
    row.organizationId !== input.organizationId ||
    row.tokenVersion !== input.tokenVersion
  ) {
    return {
      bound: true,
      valid: false,
      sessionId,
      reason: "SESSION_IDENTITY_MISMATCH",
    };
  }

  const now = input.now ?? new Date();
  if (row.absoluteExpiresAt.getTime() <= now.getTime()) {
    return {
      bound: true,
      valid: false,
      sessionId,
      reason: "ABSOLUTE_TIMEOUT",
      authenticatedAt: row.authenticatedAt,
      lastActivityAt: row.lastActivityAt,
      absoluteExpiresAt: row.absoluteExpiresAt,
    };
  }

  const policy = evaluateSessionSecurity(
    {
      authenticatedAt: row.authenticatedAt,
      lastActivityAt: row.lastActivityAt,
    },
    now
  );

  if (!policy.valid) {
    return {
      bound: true,
      valid: false,
      sessionId,
      reason: policy.reason,
      authenticatedAt: row.authenticatedAt,
      lastActivityAt: row.lastActivityAt,
      absoluteExpiresAt: row.absoluteExpiresAt,
    };
  }

  return {
    bound: true,
    valid: true,
    sessionId,
    reason: "ACTIVE",
    authenticatedAt: row.authenticatedAt,
    lastActivityAt: row.lastActivityAt,
    absoluteExpiresAt: row.absoluteExpiresAt,
  };
}

export async function expireBoundSession(
  client: SessionEnforcementClient,
  input: {
    sessionId: string;
    userId: string;
    organizationId: string;
    tokenVersion: number;
    reason: "IDLE_TIMEOUT" | "ABSOLUTE_TIMEOUT" | "INVALID_TIMELINE";
    userAgent?: string | null;
    now?: Date;
  }
): Promise<{ expired: boolean; eventRecorded: boolean }> {
  const now = input.now ?? new Date();
  const result = await client.authSession.updateMany({
    where: {
      id: input.sessionId,
      userId: input.userId,
      organizationId: input.organizationId,
      tokenVersion: input.tokenVersion,
      revokedAt: null,
    },
    data: {
      revokedAt: now,
      revokeReason: input.reason,
    },
  });

  if (result.count !== 1) {
    return { expired: false, eventRecorded: false };
  }

  try {
    await client.securityEvent.create({
      data: {
        userId: input.userId,
        organizationId: input.organizationId,
        type: "AUTH_SESSION_EXPIRED",
        userAgent: String(input.userAgent ?? "").trim() || null,
        metadata: {
          sessionId: input.sessionId,
          reason: input.reason,
        },
      },
    });
    return { expired: true, eventRecorded: true };
  } catch {
    return { expired: true, eventRecorded: false };
  }
}

export async function touchBoundSessionHumanActivity(
  client: SessionEnforcementClient,
  input: {
    sessionId?: string | null;
    userId: string;
    organizationId: string;
    tokenVersion: number;
    now?: Date;
  }
): Promise<SessionInspection & { touched: boolean }> {
  const now = input.now ?? new Date();
  const inspection = await inspectBoundSession(client, { ...input, now });

  if (!inspection.valid || !inspection.sessionId || !inspection.lastActivityAt) {
    return { ...inspection, touched: false };
  }

  if (
    now.getTime() - inspection.lastActivityAt.getTime() <
    SESSION_HUMAN_ACTIVITY_TOUCH_INTERVAL_MS
  ) {
    return { ...inspection, touched: false };
  }

  const result = await client.authSession.updateMany({
    where: {
      id: inspection.sessionId,
      userId: input.userId,
      organizationId: input.organizationId,
      tokenVersion: input.tokenVersion,
      revokedAt: null,
      lastActivityAt: inspection.lastActivityAt,
    },
    data: {
      lastActivityAt: now,
    },
  });

  return { ...inspection, touched: result.count === 1 };
}
