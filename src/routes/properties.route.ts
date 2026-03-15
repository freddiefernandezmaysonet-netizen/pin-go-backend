import { Router } from "express";
import type { PrismaClient } from "@prisma/client";
import { requireAuth } from "../middleware/requireAuth";

export function buildPropertiesRouter(prisma: PrismaClient) {
  const router = Router();

  router.use(requireAuth);

  // GET /api/properties
  router.get("/api/properties", async (req, res) => {
    try {
      const user = (req as any).user;
      const orgId = user.orgId as string;

      const items = await prisma.property.findMany({
        where: {
          organizationId: orgId,
          status: { not: "ARCHIVED" },
        },
        orderBy: { createdAt: "desc" },
        include: {
          _count: {
            select: {
              locks: true,
              reservations: {
                where: {
                  status: "ACTIVE",
                },
              },
            },
          },
          pmsConnection: true,
        },
      });

      return res.json({
        items: items.map((p) => ({
          id: p.id,
          name: p.name,
          locks: p._count.locks,
          activeReservations: p._count.reservations,
          pms: p.pmsConnection?.provider ?? "—",
          status: p.status,
          address1: p.address1 ?? "",
          city: p.city ?? "",
          region: p.region ?? "",
          country: p.country ?? "",
          timezone: p.timezone ?? "",
          checkInTime: p.checkInTime ?? "15:00",
          cleaningStartOffsetMinutes: p.cleaningStartOffsetMinutes ?? 0,
        })),
      });
    } catch (error: any) {
      console.error("GET /api/properties error:", error);
      return res.status(500).json({
        ok: false,
        error: error?.message ?? "Failed to fetch properties",
      });
    }
  });

  // POST /api/properties
  router.post("/api/properties", async (req, res) => {
    try {
      const user = (req as any).user;
      const orgId = user.orgId as string;

      const {
        name,
        address1,
        city,
        region,
        country,
        timezone,
        checkInTime,
        cleaningStartOffsetMinutes,
      } = req.body ?? {};

      if (!name || typeof name !== "string" || !name.trim()) {
        return res.status(400).json({
          ok: false,
          error: "Property name is required",
        });
      }

      const property = await prisma.property.create({
        data: {
          organizationId: orgId,
          name: name.trim(),
          address1: address1?.trim() || null,
          city: city?.trim() || null,
          region: region?.trim() || null,
          country: country?.trim() || null,
          timezone: timezone?.trim() || "America/Puerto_Rico",
          checkInTime: checkInTime || "15:00",
          cleaningStartOffsetMinutes:
            typeof cleaningStartOffsetMinutes === "number"
              ? cleaningStartOffsetMinutes
              : 0,
          status: "ACTIVE",
        },
      });

      return res.status(201).json({
        ok: true,
        item: property,
      });
    } catch (error: any) {
      console.error("POST /api/properties error:", error);
      return res.status(500).json({
        ok: false,
        error: error?.message ?? "Failed to create property",
      });
    }
  });

  // PATCH /api/properties/:id
  router.patch("/api/properties/:id", async (req, res) => {
    try {
      const user = (req as any).user;
      const orgId = user.orgId as string;
      const { id } = req.params;

      const existing = await prisma.property.findFirst({
        where: {
          id,
          organizationId: orgId,
        },
      });

      if (!existing) {
        return res.status(404).json({
          ok: false,
          error: "Property not found",
        });
      }

      const {
        name,
        address1,
        city,
        region,
        country,
        timezone,
        checkInTime,
        cleaningStartOffsetMinutes,
      } = req.body ?? {};

      const updated = await prisma.property.update({
        where: { id },
        data: {
          ...(name !== undefined ? { name: String(name).trim() } : {}),
          ...(address1 !== undefined ? { address1: address1?.trim() || null } : {}),
          ...(city !== undefined ? { city: city?.trim() || null } : {}),
          ...(region !== undefined ? { region: region?.trim() || null } : {}),
          ...(country !== undefined ? { country: country?.trim() || null } : {}),
          ...(timezone !== undefined ? { timezone: timezone?.trim() || "America/Puerto_Rico" } : {}),
          ...(checkInTime !== undefined ? { checkInTime } : {}),
          ...(cleaningStartOffsetMinutes !== undefined
            ? { cleaningStartOffsetMinutes: Number(cleaningStartOffsetMinutes) || 0 }
            : {}),
        },
      });

      return res.json({
        ok: true,
        item: updated,
      });
    } catch (error: any) {
      console.error("PATCH /api/properties/:id error:", error);
      return res.status(500).json({
        ok: false,
        error: error?.message ?? "Failed to update property",
      });
    }
  });

  // POST /api/properties/:id/archive
  router.post("/api/properties/:id/archive", async (req, res) => {
    try {
      const user = (req as any).user;
      const orgId = user.orgId as string;
      const { id } = req.params;

      const existing = await prisma.property.findFirst({
        where: {
          id,
          organizationId: orgId,
        },
        include: {
          _count: {
            select: {
              reservations: {
                where: {
                  status: "ACTIVE",
                },
              },
            },
          },
        },
      });

      if (!existing) {
        return res.status(404).json({
          ok: false,
          error: "Property not found",
        });
      }

      if (existing._count.reservations > 0) {
        return res.status(400).json({
          ok: false,
          error: "Cannot archive a property with active reservations",
        });
      }

      const archived = await prisma.property.update({
        where: { id },
        data: {
          status: "ARCHIVED",
        },
      });

      return res.json({
        ok: true,
        item: archived,
      });
    } catch (error: any) {
      console.error("POST /api/properties/:id/archive error:", error);
      return res.status(500).json({
        ok: false,
        error: error?.message ?? "Failed to archive property",
      });
    }
  });

  return router;
}
