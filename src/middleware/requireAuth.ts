import type { Request, Response, NextFunction } from "express";
import {
  buildClearAuthCookie,
  extractTokenFromRequest,
} from "../lib/auth";
import { prisma } from "../lib/prisma";
import { verifySessionBoundAuthToken } from "../auth/session-bound-token.js";
import { guardAuthenticatedSession } from "../auth/session-request-guard.js";

type AuthenticatedUser = {
  id: string;
  orgId: string;
  email?: string;
  role?: string;
  sessionId?: string;
  tokenVersion?: number;
};

function clearAuthCookie(req: Request, res: Response) {
  res.setHeader(
    "Set-Cookie",
    buildClearAuthCookie({
      requestOrigin: req.get("origin") ?? null,
    })
  );
}

export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const existingUser = (req as any).user as AuthenticatedUser | undefined;
  const allowInjectedDevAuth =
    process.env.NODE_ENV !== "production" &&
    process.env.ENABLE_DEV_AUTH === "true";

  if (allowInjectedDevAuth && existingUser?.id && existingUser?.orgId) {
    return next();
  }

  const token = extractTokenFromRequest(req);
  if (!token) {
    return res.status(401).json({ error: "UNAUTHENTICATED" });
  }

  let payload: ReturnType<typeof verifySessionBoundAuthToken>;
  try {
    payload = verifySessionBoundAuthToken(token);
  } catch {
    clearAuthCookie(req, res);
    return res.status(401).json({ error: "UNAUTHENTICATED" });
  }

  const decision = await guardAuthenticatedSession(prisma as any, {
    userId: payload.sub,
    organizationId: payload.orgId,
    tokenVersion: payload.tokenVersion,
    sessionId: payload.sid,
    userAgent: req.get("user-agent") ?? null,
  });

  if (decision.kind === "UNAVAILABLE") {
    console.error("[auth/session-e8b] VALIDATION_UNAVAILABLE", {
      mode: decision.mode,
    });
    return res.status(503).json({ error: decision.error });
  }

  if (decision.kind === "DENY") {
    if (decision.clearCookie) {
      clearAuthCookie(req, res);
    }

    console.warn("[auth/session-e8b] DENY", {
      mode: decision.mode,
      reason: decision.reason,
      error: decision.error,
    });
    return res.status(decision.status).json({ error: decision.error });
  }

  if (decision.shadowReason) {
    console.warn("[auth/session-e8b-shadow] WOULD_DENY", {
      sessionId: decision.sessionId,
      reason: decision.shadowReason,
    });
  }

  (req as any).user = {
    id: decision.user.id,
    orgId: decision.user.organizationId,
    email: decision.user.email,
    role: decision.user.role,
    sessionId: decision.sessionId ?? undefined,
    tokenVersion: decision.user.tokenVersion,
  } satisfies AuthenticatedUser;

  if (!(req as any).user?.orgId) {
    return res.status(403).json({ error: "NO_ORG" });
  }

  return next();
}
