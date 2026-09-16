import { evaluateSessionSecurity } from "./session-security.policy.js";

export type SessionBindingShadowReason =
  | "ACTIVE"
  | "UNBOUND_LEGACY"
  | "SESSION_NOT_FOUND"
  | "SESSION_REVOKED"
  | "SESSION_IDENTITY_MISMATCH"
  | "IDLE_TIMEOUT"
  | "ABSOLUTE_TIMEOUT"
  | "INVALID_TIMELINE";

export type SessionBindingShadowObservation = {
  bound: boolean;
  valid: boolean;
  sessionId: string | null;
  reason: SessionBindingShadowReason;
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

export type SessionBindingShadowClient = {
  authSession: {
    findUnique(args: unknown): Promise<AuthSessionRow | null>;
    updateMany(args: unknown): Promise<{ count: number }>;
  };
  securityEvent: {
    create(args: unknown): Promise<unknown>;
  };
};

export async function observeSessionBindingShadow(
  client: SessionBindingShadowClient,
  input: {
    sessionId?: string | null;
    userId: string;
    organizationId: string;
    tokenVersion: number;
    now?: Date;
  }
): Promise<SessionBindingShadowObservation> {
  const sessionId = String(input.sessionId ?? "").trim();
  if (!sessionId) {
    return {
      bound: false,
      valid: true,
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
    };
  }

  const decision = evaluateSessionSecurity(
    {
      authenticatedAt: row.authenticatedAt,
      lastActivityAt: row.lastActivityAt,
    },
    now
  );

  if (!decision.valid) {
    return {
      bound: true,
      valid: false,
      sessionId,
      reason: decision.reason,
    };
  }

  return {
    bound: true,
    valid: true,
    sessionId,
    reason: "ACTIVE",
  };
}

export async function revokeBoundSessionOnLogout(
  client: SessionBindingShadowClient,
  input: {
    sessionId?: string | null;
    userId: string;
    organizationId: string;
    tokenVersion: number;
    userAgent?: string | null;
    now?: Date;
  }
): Promise<{
  revoked: boolean;
  reason: "REVOKED" | "UNBOUND_LEGACY" | "NOT_ACTIVE";
}> {
  const sessionId = String(input.sessionId ?? "").trim();
  if (!sessionId) {
    return { revoked: false, reason: "UNBOUND_LEGACY" };
  }

  const now = input.now ?? new Date();
  const result = await client.authSession.updateMany({
    where: {
      id: sessionId,
      userId: input.userId,
      organizationId: input.organizationId,
      tokenVersion: input.tokenVersion,
      revokedAt: null,
    },
    data: {
      revokedAt: now,
      revokeReason: "LOGOUT",
    },
  });

  if (result.count !== 1) {
    return { revoked: false, reason: "NOT_ACTIVE" };
  }

  await client.securityEvent.create({
    data: {
      userId: input.userId,
      organizationId: input.organizationId,
      type: "AUTH_SESSION_REVOKED",
      userAgent: String(input.userAgent ?? "").trim() || null,
      metadata: {
        sessionId,
        reason: "LOGOUT",
      },
    },
  });

  return { revoked: true, reason: "REVOKED" };
}
