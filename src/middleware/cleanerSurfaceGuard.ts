import type { RequestHandler } from "express";
import type { PrismaClient } from "@prisma/client";
import { extractTokenFromRequest } from "../lib/auth.js";
import { verifySessionBoundAuthToken } from "../auth/session-bound-token.js";
import { assertCleanerIdentity } from "../auth/cleaner-surface.policy.js";
import { requireAuth } from "./requireAuth.js";

/** Covers legacy routes too, including ones without their own requireAuth. */
export function buildCleanerSurfaceGuard(prisma: PrismaClient): RequestHandler {
  return async (req, res, next) => {
    // Public booking (including guest-token portals) keeps its own access rules,
    // independent of an incidental Dashboard cookie. Match the namespace boundary.
    if (req.path === "/api/public/brand-context" || /^\/api\/public-booking(?:\/|$)/.test(req.path) || req.path.startsWith("/auth/")) return next();
    const token = extractTokenFromRequest(req);
    if (!token) return next();
    let payload;
    try { payload = verifySessionBoundAuthToken(token); } catch { return next(); }
    try {
      const account = await prisma.dashboardUser.findUnique({ where: { id: payload.sub }, select: { role: true } });
      if (account?.role !== "CLEANER" && payload.role !== "CLEANER") return next();
    } catch { return res.status(503).json({ error: "SESSION_VALIDATION_UNAVAILABLE" }); }
    return requireAuth(req, res, async () => {
      try {
        const user = (req as any).user;
        // A current host role is governed by its existing route authorization.
        if (user.role !== "CLEANER") return next();
        if (req.path === "/auth/logout") return next();
        const staff = await prisma.staffMember.findUnique({ where: { dashboardUserId: user.id } });
        assertCleanerIdentity(user, staff);
        const match = /^\/cleaning\/confirm\/([^/]+)/.exec(req.path);
        if (match) {
          const offer = await prisma.cleaningConfirmation.findFirst({ where: { token: decodeURIComponent(match[1]!), staffMemberId: staff!.id, propertyId: { not: "" } } });
          const property = offer && await prisma.property.findFirst({ where: { id: offer.propertyId, organizationId: user.orgId }, select: { id: true } });
          if (!property) return res.status(404).json({ error: "CLEANING_NOT_AVAILABLE" });
        }
        return next();
      } catch { return res.status(403).json({ error: "CLEANER_IDENTITY_REQUIRED" }); }
    });
  };
}
