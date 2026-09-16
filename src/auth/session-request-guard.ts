import {
  expireBoundSession,
  inspectBoundSession,
  isSessionExpirationReason,
  resolveSessionEnforcementMode,
  type SessionEnforcementClient,
  type SessionEnforcementMode,
  type SessionInspectionReason,
} from "./session-enforcement-runtime.js";

export type SessionGuardUser = {
  id: string;
  organizationId: string;
  email: string;
  role: string;
  isActive: boolean;
  tokenVersion: number;
  organization: {
    name: string;
    slug: string | null;
  } | null;
};

export type SessionRequestGuardClient = SessionEnforcementClient & {
  dashboardUser: {
    findUnique(args: unknown): Promise<SessionGuardUser | null>;
  };
};

export type SessionRequestGuardDecision =
  | {
      kind: "ALLOW";
      mode: SessionEnforcementMode;
      user: SessionGuardUser;
      sessionId: string | null;
      shadowReason: SessionInspectionReason | null;
    }
  | {
      kind: "DENY";
      mode: SessionEnforcementMode;
      status: 401 | 403;
      error:
        | "USER_NOT_FOUND"
        | "USER_DISABLED"
        | "SESSION_EXPIRED"
        | "SESSION_REAUTH_REQUIRED";
      clearCookie: boolean;
      reason: string;
    }
  | {
      kind: "UNAVAILABLE";
      mode: "ENFORCE";
      status: 503;
      error: "SESSION_VALIDATION_UNAVAILABLE";
      clearCookie: false;
      reason: "VALIDATION_FAILED";
    };

export async function guardAuthenticatedSession(
  client: SessionRequestGuardClient,
  input: {
    userId: string;
    organizationId: string;
    tokenVersion: number;
    sessionId?: string | null;
    userAgent?: string | null;
    mode?: SessionEnforcementMode;
    now?: Date;
  }
): Promise<SessionRequestGuardDecision> {
  const mode = input.mode ?? resolveSessionEnforcementMode();

  let user: SessionGuardUser | null;
  try {
    user = await client.dashboardUser.findUnique({
      where: { id: input.userId },
      select: {
        id: true,
        organizationId: true,
        email: true,
        role: true,
        isActive: true,
        tokenVersion: true,
        organization: {
          select: {
            name: true,
            slug: true,
          },
        },
      },
    });
  } catch {
    if (mode === "ENFORCE") {
      return {
        kind: "UNAVAILABLE",
        mode,
        status: 503,
        error: "SESSION_VALIDATION_UNAVAILABLE",
        clearCookie: false,
        reason: "VALIDATION_FAILED",
      };
    }

    throw new Error("SESSION_SHADOW_USER_LOOKUP_FAILED");
  }

  if (!user) {
    return {
      kind: "DENY",
      mode,
      status: 401,
      error: "USER_NOT_FOUND",
      clearCookie: true,
      reason: "USER_NOT_FOUND",
    };
  }

  if (!user.isActive) {
    return {
      kind: "DENY",
      mode,
      status: 403,
      error: "USER_DISABLED",
      clearCookie: false,
      reason: "USER_DISABLED",
    };
  }

  if (
    user.organizationId !== input.organizationId ||
    user.tokenVersion !== input.tokenVersion
  ) {
    return {
      kind: "DENY",
      mode,
      status: 401,
      error: "SESSION_EXPIRED",
      clearCookie: true,
      reason: "USER_TOKEN_STATE_CHANGED",
    };
  }

  let inspection;
  try {
    inspection = await inspectBoundSession(client, {
      sessionId: input.sessionId,
      userId: input.userId,
      organizationId: input.organizationId,
      tokenVersion: input.tokenVersion,
      now: input.now,
    });
  } catch {
    if (mode === "ENFORCE") {
      return {
        kind: "UNAVAILABLE",
        mode,
        status: 503,
        error: "SESSION_VALIDATION_UNAVAILABLE",
        clearCookie: false,
        reason: "VALIDATION_FAILED",
      };
    }

    return {
      kind: "ALLOW",
      mode,
      user,
      sessionId: String(input.sessionId ?? "").trim() || null,
      shadowReason: null,
    };
  }

  if (inspection.valid) {
    return {
      kind: "ALLOW",
      mode,
      user,
      sessionId: inspection.sessionId,
      shadowReason: null,
    };
  }

  if (mode === "SHADOW") {
    return {
      kind: "ALLOW",
      mode,
      user,
      sessionId: inspection.sessionId,
      shadowReason: inspection.reason,
    };
  }

  if (inspection.reason === "UNBOUND_LEGACY") {
    return {
      kind: "DENY",
      mode,
      status: 401,
      error: "SESSION_REAUTH_REQUIRED",
      clearCookie: true,
      reason: inspection.reason,
    };
  }

  if (
    inspection.sessionId &&
    isSessionExpirationReason(inspection.reason)
  ) {
    try {
      await expireBoundSession(client, {
        sessionId: inspection.sessionId,
        userId: input.userId,
        organizationId: input.organizationId,
        tokenVersion: input.tokenVersion,
        reason: inspection.reason,
        userAgent: input.userAgent,
        now: input.now,
      });
    } catch {
      // The policy decision is already terminal. Persistence/event failure must
      // not resurrect an expired session.
    }
  }

  return {
    kind: "DENY",
    mode,
    status: 401,
    error: "SESSION_EXPIRED",
    clearCookie: true,
    reason: inspection.reason,
  };
}
