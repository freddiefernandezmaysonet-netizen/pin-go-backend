import type { Request, Response, NextFunction } from "express";
import { extractTokenFromRequest, verifyAuthToken } from "../lib/auth";

type AuthenticatedUser = {
  id: string;
  orgId: string;
  email?: string;
  role?: string;
};

export function requireAuth(req: Request, res: Response, next: NextFunction) {
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

    const payload = verifyAuthToken(token);

    (req as any).user = {
      id: payload.sub,
      orgId: payload.orgId,
      email: payload.email,
      role: payload.role,
    } satisfies AuthenticatedUser;

    if (!(req as any).user?.orgId) {
      return res.status(403).json({ error: "NO_ORG" });
    }

    return next();
  } catch {
    return res.status(401).json({ error: "UNAUTHENTICATED" });
  }
}