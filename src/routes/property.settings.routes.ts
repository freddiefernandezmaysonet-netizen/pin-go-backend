import { Router } from "express";
import { PrismaClient } from "@prisma/client";

function durationFromCheckInTime(checkInTime: "15:00" | "16:00") {
  return checkInTime === "16:00" ? 240 : 180;
}

function checkInTimeFromDuration(durationMinutes: number): "15:00" | "16:00" {
  return durationMinutes >= 240 ? "16:00" : "15:00";
}

export function buildPropertySettingsRouter(prisma: PrismaClient) {
  const router = Router();

  /**
   * GET /api/admin/properties/:propertyId/cleaning-settings
   * Devuelve settings listos para el UI (incluye checkInTime derivado).
   */
  router.get("/:propertyId/cleaning-settings", async (req, res) => {
    try {
      const propertyId = String(req.params.propertyId);

      const p = await prisma.property.findUnique({
        where: { id: propertyId },
        select: {
          id: true,
          name: true,
          cleaningStartOffsetMinutes: true,
          cleaningDurationMinutes: true,
          timezone: true,
          updatedAt: true,
        },
      });

      if (!p) return res.status(404).json({ ok: false, error: "Property not found" });

      return res.json({
        ok: true,
        property: {
          ...p,
          checkInTime: checkInTimeFromDuration(p.cleaningDurationMinutes ?? 180),
        },
      });
    } catch (e: any) {
      return res.status(500).json({ ok: false, error: e?.message ?? "failed" });
    }
  });

  /**
   * PATCH /api/admin/properties/:propertyId/cleaning-settings
   * Body:
   *  - checkInTime: "15:00" | "16:00"  (3pm/4pm)
   *  - cleaningStartOffsetMinutes?: number (editable)
   *
   * Regla:
   *  - "15:00" => cleaningDurationMinutes = 180
   *  - "16:00" => cleaningDurationMinutes = 240
   */
  router.patch("/:propertyId/cleaning-settings", async (req, res) => {
    try {
      const propertyId = String(req.params.propertyId);
      const { checkInTime, cleaningStartOffsetMinutes } = req.body ?? {};

      if (checkInTime !== "15:00" && checkInTime !== "16:00") {
        return res.status(400).json({
          ok: false,
          error: 'Invalid checkInTime. Use "15:00" or "16:00".',
        });
      }

      const data: any = {
        cleaningDurationMinutes: durationFromCheckInTime(checkInTime),
      };

      if (cleaningStartOffsetMinutes !== undefined) {
        const n = Number(cleaningStartOffsetMinutes);
        if (!Number.isFinite(n) || n < 0 || n > 180) {
          return res.status(400).json({
            ok: false,
            error: "cleaningStartOffsetMinutes must be a number between 0 and 180",
          });
        }
        data.cleaningStartOffsetMinutes = n;
      }

      const updated = await prisma.property.update({
        where: { id: propertyId },
        data,
        select: {
          id: true,
          name: true,
          cleaningStartOffsetMinutes: true,
          cleaningDurationMinutes: true,
          timezone: true,
          updatedAt: true,
        },
      });

      return res.json({
        ok: true,
        property: {
          ...updated,
          checkInTime: checkInTimeFromDuration(updated.cleaningDurationMinutes ?? 180),
        },
      });
    } catch (e: any) {
      return res.status(500).json({ ok: false, error: e?.message ?? "failed" });
    }
  });

  return router;
}
