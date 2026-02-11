import type { Request, Response, NextFunction } from "express";
import { PrismaClient } from "@prisma/client";

// Tip: extiende Request para guardar orgId
export type OrgRequest = Request & { orgId?: string };

export function requireOrg(prisma: PrismaClient) {
  return async (req: OrgRequest, res: Response, next: NextFunction) => {
    // DEV: lo recibimos por header (o query)
    const orgId =
      String(req.header("x-org-id") ?? "").trim() ||
      String(req.query.organizationId ?? "").trim();

    if (!orgId) return res.status(400).json({ ok: false, error: "ORGANIZATION_ID_REQUIRED" });

    const org = await prisma.organization.findUnique({
      where: { id: orgId },
      select: { id: true },
    });

    if (!org) return res.status(404).json({ ok: false, error: "ORG_NOT_FOUND" });

    req.orgId = orgId;
    next();
  };
}
