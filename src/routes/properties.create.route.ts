import { Router } from "express";
import type { PrismaClient } from "@prisma/client";
import { requireAuth } from "../middleware/requireAuth";

function durationFromCheckInTime(checkInTime: "15:00" | "16:00") {
  return checkInTime === "16:00" ? 240 : 180;
}

export function buildCreatePropertyRouter(prisma: PrismaClient) {
  const router = Router();

  router.post("/api/properties", requireAuth, async (req, res) => {
    try {
      const user = (req as any).user;
      const orgId = String(user.orgId ?? "").trim();

      if (!orgId) {
        return res.status(400).json({
          ok: false,
          error: "Authenticated user has no organization",
        });
      }

      const name = String(req.body?.name ?? "").trim();
      const address1 =
        req.body?.address1 != null ? String(req.body.address1).trim() : null;
      const city =
        req.body?.city != null ? String(req.body.city).trim() : null;
      const region =
        req.body?.region != null ? String(req.body.region).trim() : null;
      const country =
        req.body?.country != null ? String(req.body.country).trim() : null;
      const timezone =
        req.body?.timezone != null ? String(req.body.timezone).trim() : "America/Puerto_Rico";

      const checkInTime = req.body?.checkInTime as "15:00" | "16:00" | undefined;
      const cleaningStartOffsetMinutesRaw = req.body?.cleaningStartOffsetMinutes;

      if (!name) {
        return res.status(400).json({
          ok: false,
          error: "Property name is required",
        });
      }

      if (checkInTime !== "15:00" && checkInTime !== "16:00") {
        return res.status(400).json({
          ok: false,
          error: 'Invalid checkInTime. Use "15:00" or "16:00".',
        });
      }

      const cleaningStartOffsetMinutes =
        cleaningStartOffsetMinutesRaw === undefined || cleaningStartOffsetMinutesRaw === null
          ? 30
          : Number(cleaningStartOffsetMinutesRaw);

      if (
        !Number.isFinite(cleaningStartOffsetMinutes) ||
        cleaningStartOffsetMinutes < 0 ||
        cleaningStartOffsetMinutes > 180
      ) {
        return res.status(400).json({
          ok: false,
          error: "cleaningStartOffsetMinutes must be a number between 0 and 180",
        });
      }

      const property = await prisma.property.create({
        data: {
          organizationId: orgId,
          name,
          address1,
          city,
          region,
          country,
          timezone,
          cleaningDurationMinutes: durationFromCheckInTime(checkInTime),
          cleaningStartOffsetMinutes,
        },
        select: {
          id: true,
          organizationId: true,
          name: true,
          address1: true,
          city: true,
          region: true,
          country: true,
          timezone: true,
          cleaningDurationMinutes: true,
          cleaningStartOffsetMinutes: true,
          createdAt: true,
        },
      });

      return res.status(201).json({
        ok: true,
        property: {
          ...property,
          checkInTime,
        },
      });
    } catch (e: any) {
      console.error("create property error:", e?.message ?? e);
      return res.status(500).json({
        ok: false,
        error: e?.message ?? "Failed to create property",
      });
    }
  });

  return router;
}