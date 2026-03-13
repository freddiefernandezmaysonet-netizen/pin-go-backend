import type { Request, Response, NextFunction } from "express";
import type { PrismaClient } from "@prisma/client";

export function requireOrg(_prisma?: PrismaClient) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as any).user;

      const orgIdFromUser = user?.orgId ? String(user.orgId).trim() : "";
      const orgIdFromBody = req.body?.organizationId
        ? String(req.body.organizationId).trim()
        : "";
      const orgIdFromQuery = req.query?.organizationId
        ? String(req.query.organizationId).trim()
        : "";
      const orgIdFromHeader = req.header("x-organization-id")
        ? String(req.header("x-organization-id")).trim()
        : "";

      const orgId =
        orgIdFromUser ||
        orgIdFromBody ||
        orgIdFromQuery ||
        orgIdFromHeader;

      if (!orgId) {
        return res.status(400).json({
          ok: false,
          error: "ORGANIZATION_ID_REQUIRED",
        });
      }

      (req as any).orgId = orgId;
      next();
    } catch (e: any) {
      return res.status(500).json({
        ok: false,
        error: e?.message ?? "REQUIRE_ORG_FAILED",
      });
    }
  };
}