import type { Request, Response, NextFunction } from "express";

const ORG_ADMIN_ROLES = new Set(["ADMIN", "ORG_ADMIN", "PLATFORM_ADMIN"]);

export function requireOrgAdmin(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const user = (req as any).user as
    | {
        id?: string;
        orgId?: string;
        email?: string;
        role?: string;
      }
    | undefined;

  if (!user?.id || !user?.orgId) {
    return res.status(401).json({
      ok: false,
      error: "UNAUTHENTICATED",
    });
  }

  if (!user.role || !ORG_ADMIN_ROLES.has(user.role)) {
    return res.status(403).json({
      ok: false,
      error: "ORG_ADMIN_REQUIRED",
    });
  }

  return next();
}