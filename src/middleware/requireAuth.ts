import type { Request, Response, NextFunction } from "express";

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const user = (req as any).user;

  if (!user?.id) {
    return res.status(401).json({ error: "UNAUTHENTICATED" });
  }

  if (!user?.orgId) {
    return res.status(403).json({ error: "NO_ORG" });
  }

  next();
}