import type { Request, Response, NextFunction } from "express";
import { extractTokenFromRequest } from "../lib/auth";
import { prisma } from "../lib/prisma";
import { verifySessionBoundAuthToken } from "../auth/session-bound-token.js";
import { observeSessionBindingShadow } from "../auth/session-binding-shadow.js";

type AuthenticatedUser = {
  id: string;
  orgId: string;
  email?: string;
  role?: string;
  sessionId?: string;
};

export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction
) {
  // 1) Compatibilidad con el modo actual de desarrollo:
  // si server.ts sigue inyectando req.user manualmente, esto continúa funcionando.
  const existingUser = (req as any).user as AuthenticatedUser | undefined;

  if (existingUser?.id && existingUser?.orgId) {
    return next();
  }

  // 2) Auth real por token (Bearer o cookie)
  try {
    const token = extractTokenFromRequest(req);

    if (!token) {
      return res.status(401).json({ error: "UNAUTHENTICATED" });
    }

    const payload = verifySessionBoundAuthToken(token);

    (req as any).user = {
      id: payload.sub,
      orgId: payload.orgId,
      email: payload.email,
      role: payload.role,
      sessionId: payload.sid,
    } satisfies AuthenticatedUser;

    if (!(req as any).user?.orgId) {
      return res.status(403).json({ error: "NO_ORG" });
    }

    try {
      const observation = await observeSessionBindingShadow(prisma as any, {
        sessionId: payload.sid,
        userId: payload.sub,
        organizationId: payload.orgId,
        tokenVersion: payload.tokenVersion,
      });

      if (observation.bound && !observation.valid) {
        console.warn("[auth/session-e8a-shadow] WOULD_DENY", {
          sessionId: observation.sessionId,
          reason: observation.reason,
        });
      }
    } catch (shadowError) {
      console.error(
        "[auth/session-e8a-shadow] OBSERVATION_FAILED",
        shadowError
      );
    }

    return next();
  } catch {
    return res.status(401).json({ error: "UNAUTHENTICATED" });
  }
}
