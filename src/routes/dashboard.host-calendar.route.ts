import { Router } from "express";
import type { PrismaClient } from "@prisma/client";
import { requireAuth } from "../middleware/requireAuth.js";
import {
  getHostCalendar,
  parseCalendarQuery,
  type CalendarPricing,
} from "../services/host-calendar.service.js";

export function buildHostCalendarRouter(
  db: PrismaClient,
  pricing: CalendarPricing,
) {
  const router = Router();
  router.get("/api/dashboard/calendar", requireAuth, async (req, res) => {
    res.setHeader("Cache-Control", "private, no-store");
    try {
      const organizationId = String((req as any).user?.orgId ?? "");
      const query = parseCalendarQuery(req.query);
      const calendar = await getHostCalendar(
        db,
        pricing,
        organizationId,
        query,
      );
      return res.json(calendar);
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      if (code === "CALENDAR_PROPERTY_NOT_FOUND")
        return res.status(404).json({ error: code });
      if (code === "CALENDAR_UNAUTHENTICATED")
        return res.status(401).json({ error: code });
      if (
        [
          "CALENDAR_RANGE_INVALID",
          "CALENDAR_PAGE_INVALID",
          "CALENDAR_PROPERTY_INVALID",
        ].includes(code)
      )
        return res.status(400).json({ error: code });
      return res.status(503).json({ error: "CALENDAR_UNAVAILABLE" });
    }
  });
  return router;
}
