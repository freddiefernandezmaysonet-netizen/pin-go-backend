import type { Request, Response, NextFunction } from "express";
import { PrismaClient } from "@prisma/client";

export type OrgRequest = Request & {
  orgId?: string;
  user?: {
    orgId?: string;
  };
};

export function requireOrg(prisma: PrismaClient) {
  return async (req: OrgRequest, res: Response, next: NextFunction) => {
    try {
      const orgId =
        String(req.header("x-org-id") ?? "").trim() ||
        String(req.query.organizationId ?? "").trim() ||
        String(req.user?.orgId ?? "").trim();

      if (!orgId) {
        return res.status(400).json({ ok: false, error: "ORGANIZATION_ID_REQUIRED" });
      }

      const org = await prisma.organization.findUnique({
        where: { id: orgId },
        select: { id: true },
      });

      if (!org) {
        return res.status(404).json({ ok: false, error: "ORG_NOT_FOUND" });
      }

      req.orgId = orgId;
      next();
    } catch (e: any) {
      return res.status(500).json({
        ok: false,
        error: e?.message ?? "requireOrg failed",
      });
    }
  };
}