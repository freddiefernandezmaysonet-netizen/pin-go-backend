import { Router } from "express";
import { PrismaClient, ReservationStatus } from "@prisma/client";
import { requireAuth } from "../middleware/requireAuth";

const prisma = new PrismaClient();
export const dashboardPropertiesRouter = Router();

function getOperationalStatus(r: {
  status: ReservationStatus;
  checkIn: Date;
  checkOut: Date;
}) {
  const now = new Date();

  if (r.status === ReservationStatus.CANCELLED) return "CANCELLED";
  if (now < r.checkIn) return "UPCOMING";
  if (now >= r.checkIn && now < r.checkOut) return "IN_HOUSE";
  return "CHECKED_OUT";
}

function parseOptionalCoordinate(value: unknown): number | null {
  if (value === undefined || value === null || String(value).trim() === "") {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : NaN;
}

dashboardPropertiesRouter.get(
  "/api/dashboard/properties",
  requireAuth,
  async (req, res) => {
    try {
      const user = (req as any).user;
      const orgId = user.orgId as string;

      const rows = await prisma.property.findMany({
        where: {
          organizationId: orgId,
          status: "ACTIVE",
        },
        orderBy: { name: "asc" },
        select: {
          id: true,
          name: true,
          status: true,
          locks: {
            where: { isActive: true },
            select: { id: true },
          },
          reservations: {
            where: { status: ReservationStatus.ACTIVE },
            select: {
              id: true,
              checkIn: true,
              checkOut: true,
              status: true,
              externalProvider: true,
              source: true,
            },
          },
        },
      });

      const items = rows.map((p) => {
        const operationalReservations = p.reservations.filter((r) => {
          const operationalStatus = getOperationalStatus(r);
          return (
            operationalStatus === "UPCOMING" ||
            operationalStatus === "IN_HOUSE"
          );
        });

        const firstRes = p.reservations[0];

        return {
          id: p.id,
          name: p.name,
          locks: p.locks.length,
          activeReservations: operationalReservations.length,
          pms: firstRes?.externalProvider ?? firstRes?.source ?? "manual",
          status: p.status,
        };
      });

      return res.json({ items });
    } catch (error: any) {
      console.error("GET /api/dashboard/properties error", error);
      return res.status(500).json({
        ok: false,
        error: error?.message ?? "Failed to load properties",
      });
    }
  }
);

dashboardPropertiesRouter.get(
  "/api/dashboard/properties/:id",
  requireAuth,
  async (req, res) => {
    try {
      const user = (req as any).user;
      const orgId = user.orgId as string;
      const { id } = req.params;

      const property = await prisma.property.findFirst({
        where: {
          id,
          organizationId: orgId,
        },
        select: {
          id: true,
          name: true,
          address1: true,
          city: true,
          region: true,
          country: true,
          timezone: true,
          status: true,
          latitude: true,
          longitude: true,
          cleaningDurationMinutes: true,
          cleaningStartOffsetMinutes: true,
          createdAt: true,
          updatedAt: true,
        },
      });

      if (!property) {
        return res.status(404).json({
          ok: false,
          error: "Property not found",
        });
      }

      return res.json({
        ok: true,
        item: property,
      });
    } catch (error: any) {
      console.error("GET /api/dashboard/properties/:id error", error);
      return res.status(500).json({
        ok: false,
        error: error?.message ?? "Failed to load property",
      });
    }
  }
);

dashboardPropertiesRouter.patch(
  "/api/dashboard/properties/:id",
  requireAuth,
  async (req, res) => {
    try {
      const user = (req as any).user;
      const orgId = user.orgId as string;
      const { id } = req.params;

      const {
        name,
        address1,
        city,
        region,
        country,
        timezone,
        cleaningDurationMinutes,
        cleaningStartOffsetMinutes,
        latitude: latitudeRaw,
        longitude: longitudeRaw,
      } = req.body ?? {};

      const latitude = parseOptionalCoordinate(latitudeRaw);
      const longitude = parseOptionalCoordinate(longitudeRaw);

      if (Number.isNaN(latitude)) {
        return res.status(400).json({
          ok: false,
          error: "latitude must be a valid number",
        });
      }

      if (Number.isNaN(longitude)) {
        return res.status(400).json({
          ok: false,
          error: "longitude must be a valid number",
        });
      }

      if (latitudeRaw !== undefined || longitudeRaw !== undefined) {
        if ((latitude !== null) !== (longitude !== null)) {
          return res.status(400).json({
            ok: false,
            error: "latitude and longitude must be provided together",
          });
        }

        if (latitude !== null && (latitude < -90 || latitude > 90)) {
          return res.status(400).json({
            ok: false,
            error: "latitude must be between -90 and 90",
          });
        }

        if (longitude !== null && (longitude < -180 || longitude > 180)) {
          return res.status(400).json({
            ok: false,
            error: "longitude must be between -180 and 180",
          });
        }
      }

      const existing = await prisma.property.findFirst({
        where: {
          id,
          organizationId: orgId,
        },
        select: {
          id: true,
          status: true,
        },
      });

      if (!existing) {
        return res.status(404).json({
          ok: false,
          error: "Property not found",
        });
      }

      if (existing.status === "ARCHIVED") {
        return res.status(400).json({
          ok: false,
          error: "Cannot edit an archived property",
        });
      }

      const data: any = {};

      if (name !== undefined) {
        const cleanName = String(name).trim();
        if (!cleanName) {
          return res.status(400).json({
            ok: false,
            error: "Property name is required",
          });
        }
        data.name = cleanName;
      }

      if (address1 !== undefined) {
        data.address1 = String(address1 || "").trim() || null;
      }

      if (city !== undefined) {
        data.city = String(city || "").trim() || null;
      }

      if (region !== undefined) {
        data.region = String(region || "").trim() || null;
      }

      if (country !== undefined) {
        data.country = String(country || "").trim() || null;
      }

      if (timezone !== undefined) {
        data.timezone = String(timezone || "").trim() || null;
      }

      if (cleaningDurationMinutes !== undefined) {
        const n = Number(cleaningDurationMinutes);
        if (!Number.isFinite(n) || n < 0) {
          return res.status(400).json({
            ok: false,
            error: "cleaningDurationMinutes must be a valid number",
          });
        }
        data.cleaningDurationMinutes = n;
      }

      if (cleaningStartOffsetMinutes !== undefined) {
        const n = Number(cleaningStartOffsetMinutes);
        if (!Number.isFinite(n) || n < 0) {
          return res.status(400).json({
            ok: false,
            error: "cleaningStartOffsetMinutes must be a valid number",
          });
        }
        data.cleaningStartOffsetMinutes = n;
      }

      if (latitudeRaw !== undefined) {
        data.latitude = latitude;
      }

      if (longitudeRaw !== undefined) {
        data.longitude = longitude;
      }

      const updated = await prisma.property.update({
        where: { id: existing.id },
        data,
        select: {
          id: true,
          name: true,
          address1: true,
          city: true,
          region: true,
          country: true,
          timezone: true,
          status: true,
          latitude: true,
          longitude: true,
          cleaningDurationMinutes: true,
          cleaningStartOffsetMinutes: true,
          updatedAt: true,
        },
      });

      return res.json({
        ok: true,
        item: updated,
      });
    } catch (error: any) {
      console.error("PATCH /api/dashboard/properties/:id error", error);
      return res.status(500).json({
        ok: false,
        error: error?.message ?? "Failed to update property",
      });
    }
  }
);

dashboardPropertiesRouter.post(
  "/api/dashboard/properties/:id/archive",
  requireAuth,
  async (req, res) => {
    try {
      const user = (req as any).user;
      const orgId = user.orgId as string;
      const { id } = req.params;

      const property = await prisma.property.findFirst({
        where: {
          id,
          organizationId: orgId,
        },
        select: {
          id: true,
          name: true,
          status: true,
          reservations: {
            where: {
              status: ReservationStatus.ACTIVE,
            },
            select: {
              id: true,
              checkIn: true,
              checkOut: true,
              status: true,
            },
          },
        },
      });

      if (!property) {
        return res.status(404).json({
          ok: false,
          error: "Property not found",
        });
      }

      if (property.status === "ARCHIVED") {
        return res.json({
          ok: true,
          alreadyArchived: true,
        });
      }

      const operationalReservations = property.reservations.filter((r) => {
        const operationalStatus = getOperationalStatus(r);
        return (
          operationalStatus === "UPCOMING" ||
          operationalStatus === "IN_HOUSE"
        );
      });

      if (operationalReservations.length > 0) {
        return res.status(400).json({
          ok: false,
          error: "Cannot archive a property with upcoming or in-house reservations",
        });
      }

      const updated = await prisma.property.update({
        where: { id: property.id },
        data: {
          status: "ARCHIVED",
        },
        select: {
          id: true,
          name: true,
          status: true,
        },
      });

      return res.json({
        ok: true,
        item: updated,
      });
    } catch (error: any) {
      console.error("POST /api/dashboard/properties/:id/archive error", error);
      return res.status(500).json({
        ok: false,
        error: error?.message ?? "Failed to archive property",
      });
    }
  }
);