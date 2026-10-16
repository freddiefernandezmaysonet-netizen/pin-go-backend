import { Router } from "express";
import type { PrismaClient } from "@prisma/client";
import { requireAuth } from "../middleware/requireAuth.js";
import { listHostCleanings, parseHostCleaningFilters } from "../services/host-cleanings.service.js";
export function buildHostCleaningsRouter(db: PrismaClient) {
  const router = Router();
  router.get("/api/host/cleanings", requireAuth, async (req: any, res) => {
    if (!["ADMIN", "ORG_ADMIN", "PLATFORM_ADMIN"].includes(req.user?.role) || !req.user?.orgId) return res.status(403).json({ error: "HOST_ADMIN_REQUIRED" });
    let filters;
    try { filters = parseHostCleaningFilters(req.query); }
    catch { return res.status(400).json({ error: "CLEANING_FILTER_INVALID" }); }
    try {
      res.setHeader("Cache-Control", "no-store");
      return res.json(await listHostCleanings(db, req.user.orgId, filters));
    } catch (error) {
      console.error("[host-cleanings] read failed", error instanceof Error ? error.name : "unknown");
      return res.status(500).json({ error: "CLEANINGS_UNAVAILABLE" });
    }
  });
  return router;
}
