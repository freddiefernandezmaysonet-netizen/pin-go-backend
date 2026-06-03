import { Router } from "express";
import { AmenityChargeMode, AmenityFeeType, PrismaClient, ReservationStatus } from "@prisma/client";
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

function parseOptionalMoney(value: unknown): number | null {
  if (value === undefined || value === null || String(value).trim() === "") {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : NaN;
}

function parseOptionalInt(value: unknown): number | null {
  if (value === undefined || value === null || String(value).trim() === "") {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : NaN;
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
          slug: true,
          isPublicBookable: true,
          publicTitle: true,
          publicDescription: true,
          publicPhotos: true,
          baseNightlyRate: true,
          cleaningFee: true,
          maxGuests: true,
          minimumNights: true,
          maximumNights: true,
          checkInTime: true,
          checkOutTime: true,
          amenities: {
          orderBy: { name: "asc" },
          select: {
          id: true,
          name: true,
          feeType: true,
          amount: true,
          description: true,
          chargeMode: true,
          isActive: true,
          createdAt: true,
          updatedAt: true,
        },
       },
         taxes: {
         orderBy: { name: "asc" },
         select: {
         id: true,
         name: true,
         percentage: true,
         isActive: true,
         createdAt: true,
         updatedAt: true,
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
        slug,
        isPublicBookable,
        publicTitle,
        publicDescription,
        publicPhotos,
        baseNightlyRate: baseNightlyRateRaw,
        cleaningFee: cleaningFeeRaw,
        maxGuests: maxGuestsRaw,
        minimumNights: minimumNightsRaw,
        maximumNights: maximumNightsRaw,
        checkInTime,
        checkOutTime,
      } = req.body ?? {};

      const latitude = parseOptionalCoordinate(latitudeRaw);
      const longitude = parseOptionalCoordinate(longitudeRaw);
const baseNightlyRate = parseOptionalMoney(baseNightlyRateRaw);
const cleaningFee = parseOptionalMoney(cleaningFeeRaw);
const maxGuests = parseOptionalInt(maxGuestsRaw);
const minimumNights = parseOptionalInt(minimumNightsRaw);
const maximumNights = parseOptionalInt(maximumNightsRaw);

if (Number.isNaN(baseNightlyRate)) {
  return res.status(400).json({ ok: false, error: "baseNightlyRate must be a valid amount" });
}

if (Number.isNaN(cleaningFee)) {
  return res.status(400).json({ ok: false, error: "cleaningFee must be a valid amount" });
}

if (Number.isNaN(maxGuests)) {
  return res.status(400).json({ ok: false, error: "maxGuests must be a valid number" });
}

if (Number.isNaN(minimumNights)) {
  return res.status(400).json({ ok: false, error: "minimumNights must be a valid number" });
}

if (Number.isNaN(maximumNights)) {
  return res.status(400).json({ ok: false, error: "maximumNights must be a valid number" });
}

if (
  minimumNights !== null &&
  maximumNights !== null &&
  maximumNights > 0 &&
  minimumNights > maximumNights
) {
  return res.status(400).json({
    ok: false,
    error: "minimumNights cannot be greater than maximumNights",
  });
}

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

  const normalizedDuration = Math.trunc(n);

  data.cleaningDurationMinutes = normalizedDuration;

  // 🔒 Mantener Property.checkInTime sincronizado con el dashboard
  if (normalizedDuration === 240) {
    data.checkInTime = "16:00";
  } else {
    data.checkInTime = "15:00";
  }
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

if (slug !== undefined) {
  data.slug = String(slug || "").trim() || null;
}

if (isPublicBookable !== undefined) {
  data.isPublicBookable = Boolean(isPublicBookable);
}

if (publicTitle !== undefined) {
  data.publicTitle = String(publicTitle || "").trim() || null;
}

if (publicDescription !== undefined) {
  data.publicDescription = String(publicDescription || "").trim() || null;
}

if (publicPhotos !== undefined) {
  data.publicPhotos = Array.isArray(publicPhotos) ? publicPhotos : null;
}

if (baseNightlyRateRaw !== undefined) {
  data.baseNightlyRate = baseNightlyRate;
}

if (cleaningFeeRaw !== undefined) {
  data.cleaningFee = cleaningFee;
}

if (maxGuestsRaw !== undefined) {
  data.maxGuests = maxGuests;
}

if (minimumNightsRaw !== undefined) {
  data.minimumNights = minimumNights ?? 1;
}

if (maximumNightsRaw !== undefined) {
  data.maximumNights = maximumNights && maximumNights > 0 ? maximumNights : null;
}

if (checkInTime !== undefined) {
  data.checkInTime = String(checkInTime || "").trim() || null;
}

if (checkOutTime !== undefined) {
  data.checkOutTime = String(checkOutTime || "").trim() || null;
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
          slug: true,
          isPublicBookable: true,
          publicTitle: true,
          publicDescription: true,
          publicPhotos: true,
          baseNightlyRate: true,
          cleaningFee: true,
          maxGuests: true,
          minimumNights: true,
          maximumNights: true,
          checkInTime: true,
          checkOutTime: true,
          amenities: {
            orderBy: { name: "asc" },
            select: {
            id: true,
            name: true,
            feeType: true,
            amount: true,
            description: true,
            chargeMode: true,
            isActive: true,
            createdAt: true,
            updatedAt: true,
          },
        },
        taxes: {
          orderBy: { name: "asc" },
          select: {
            id: true,
            name: true,
            percentage: true,
            isActive: true,
            createdAt: true,
            updatedAt: true,
          },
         },
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
  "/api/dashboard/properties/:id/amenities",
  requireAuth,
  async (req, res) => {
    try {
      const user = (req as any).user;
      const orgId = user.orgId as string;
      const { id } = req.params;
      const { name, description, chargeMode, feeType, amount } = req.body ?? {};

const cleanDescription = String(description || "").trim() || null;
const cleanChargeMode = String(chargeMode || "INCLUDED").trim();

if (!Object.values(AmenityChargeMode).includes(cleanChargeMode as AmenityChargeMode)) {
  return res.status(400).json({ ok: false, error: "Invalid amenity chargeMode" });
}
      
      const property = await prisma.property.findFirst({
        where: { id, organizationId: orgId, status: "ACTIVE" },
        select: { id: true },
      });

      if (!property) {
        return res.status(404).json({ ok: false, error: "Property not found" });
      }

      const cleanName = String(name || "").trim();
      const cleanFeeType = String(feeType || "PER_STAY").trim();
      const parsedAmount = Number(amount ?? 0);

      if (!cleanName) {
        return res.status(400).json({ ok: false, error: "Amenity name is required" });
      }

      if (!Object.values(AmenityFeeType).includes(cleanFeeType as AmenityFeeType)) {
        return res.status(400).json({ ok: false, error: "Invalid amenity feeType" });
      }

      if (!Number.isFinite(parsedAmount) || parsedAmount < 0) {
        return res.status(400).json({ ok: false, error: "Amenity amount must be valid" });
      }

      const item = await prisma.propertyAmenity.create({
       data: {
  propertyId: property.id,
  name: cleanName,
  description: cleanDescription,
  chargeMode: cleanChargeMode as AmenityChargeMode,
  feeType: cleanFeeType as AmenityFeeType,
  amount: parsedAmount,
}, 
      });

      return res.json({ ok: true, item });
    } catch (error: any) {
      console.error("POST amenity error", error);
      return res.status(500).json({ ok: false, error: error?.message ?? "Failed to create amenity" });
    }
  }
);

dashboardPropertiesRouter.patch(
  "/api/dashboard/properties/:id/amenities/:amenityId",
  requireAuth,
  async (req, res) => {
    try {
      const user = (req as any).user;
      const orgId = user.orgId as string;
      const { id, amenityId } = req.params;
      const { name, description, chargeMode, feeType, amount, isActive } = req.body ?? {};

      const amenity = await prisma.propertyAmenity.findFirst({
        where: {
          id: amenityId,
          propertyId: id,
          property: { organizationId: orgId },
        },
        select: { id: true },
      });

      if (!amenity) {
        return res.status(404).json({ ok: false, error: "Amenity not found" });
      }

      const data: any = {};

      if (name !== undefined) {
        const cleanName = String(name || "").trim();
        if (!cleanName) {
          return res.status(400).json({ ok: false, error: "Amenity name is required" });
        }
        data.name = cleanName;
      }

if (description !== undefined) {
  data.description = String(description || "").trim() || null;
}

if (chargeMode !== undefined) {
  const cleanChargeMode = String(chargeMode || "").trim();

  if (!Object.values(AmenityChargeMode).includes(cleanChargeMode as AmenityChargeMode)) {
    return res.status(400).json({ ok: false, error: "Invalid amenity chargeMode" });
  }

  data.chargeMode = cleanChargeMode as AmenityChargeMode;
}

      if (feeType !== undefined) {
        const cleanFeeType = String(feeType || "").trim();
        if (!Object.values(AmenityFeeType).includes(cleanFeeType as AmenityFeeType)) {
          return res.status(400).json({ ok: false, error: "Invalid amenity feeType" });
        }
        data.feeType = cleanFeeType;
      }

      if (amount !== undefined) {
        const parsedAmount = Number(amount);
        if (!Number.isFinite(parsedAmount) || parsedAmount < 0) {
          return res.status(400).json({ ok: false, error: "Amenity amount must be valid" });
        }
        data.amount = parsedAmount;
      }

      if (isActive !== undefined) {
        data.isActive = Boolean(isActive);
      }

      const item = await prisma.propertyAmenity.update({
        where: { id: amenity.id },
        data,
      });

      return res.json({ ok: true, item });
    } catch (error: any) {
      console.error("PATCH amenity error", error);
      return res.status(500).json({ ok: false, error: error?.message ?? "Failed to update amenity" });
    }
  }
);

dashboardPropertiesRouter.delete(
  "/api/dashboard/properties/:id/amenities/:amenityId",
  requireAuth,
  async (req, res) => {
    try {
      const user = (req as any).user;
      const orgId = user.orgId as string;
      const { id, amenityId } = req.params;

      const amenity = await prisma.propertyAmenity.findFirst({
        where: {
          id: amenityId,
          propertyId: id,
          property: { organizationId: orgId },
        },
        select: { id: true },
      });

      if (!amenity) {
        return res.status(404).json({ ok: false, error: "Amenity not found" });
      }

      await prisma.propertyAmenity.update({
        where: { id: amenity.id },
        data: { isActive: false },
      });

      return res.json({ ok: true });
    } catch (error: any) {
      console.error("DELETE amenity error", error);
      return res.status(500).json({ ok: false, error: error?.message ?? "Failed to delete amenity" });
    }
  }
);

dashboardPropertiesRouter.post(
  "/api/dashboard/properties/:id/taxes",
  requireAuth,
  async (req, res) => {
    try {
      const user = (req as any).user;
      const orgId = user.orgId as string;
      const { id } = req.params;
      const { name, percentage } = req.body ?? {};

      const property = await prisma.property.findFirst({
        where: { id, organizationId: orgId, status: "ACTIVE" },
        select: { id: true },
      });

      if (!property) {
        return res.status(404).json({ ok: false, error: "Property not found" });
      }

      const cleanName = String(name || "").trim();
      const parsedPercentage = Number(percentage ?? 0);

      if (!cleanName) {
        return res.status(400).json({ ok: false, error: "Tax name is required" });
      }

      if (!Number.isFinite(parsedPercentage) || parsedPercentage < 0 || parsedPercentage > 100) {
        return res.status(400).json({ ok: false, error: "Tax percentage must be between 0 and 100" });
      }

      const item = await prisma.propertyTax.create({
        data: {
          propertyId: property.id,
          name: cleanName,
          percentage: parsedPercentage,
        },
      });

      return res.json({ ok: true, item });
    } catch (error: any) {
      console.error("POST tax error", error);
      return res.status(500).json({ ok: false, error: error?.message ?? "Failed to create tax" });
    }
  }
);

dashboardPropertiesRouter.patch(
  "/api/dashboard/properties/:id/taxes/:taxId",
  requireAuth,
  async (req, res) => {
    try {
      const user = (req as any).user;
      const orgId = user.orgId as string;
      const { id, taxId } = req.params;
      const { name, percentage, isActive } = req.body ?? {};

      const tax = await prisma.propertyTax.findFirst({
        where: {
          id: taxId,
          propertyId: id,
          property: { organizationId: orgId },
        },
        select: { id: true },
      });

      if (!tax) {
        return res.status(404).json({ ok: false, error: "Tax not found" });
      }

      const data: any = {};

      if (name !== undefined) {
        const cleanName = String(name || "").trim();
        if (!cleanName) {
          return res.status(400).json({ ok: false, error: "Tax name is required" });
        }
        data.name = cleanName;
      }

      if (percentage !== undefined) {
        const parsedPercentage = Number(percentage);
        if (!Number.isFinite(parsedPercentage) || parsedPercentage < 0 || parsedPercentage > 100) {
          return res.status(400).json({ ok: false, error: "Tax percentage must be between 0 and 100" });
        }
        data.percentage = parsedPercentage;
      }

      if (isActive !== undefined) {
        data.isActive = Boolean(isActive);
      }

      const item = await prisma.propertyTax.update({
        where: { id: tax.id },
        data,
      });

      return res.json({ ok: true, item });
    } catch (error: any) {
      console.error("PATCH tax error", error);
      return res.status(500).json({ ok: false, error: error?.message ?? "Failed to update tax" });
    }
  }
);

dashboardPropertiesRouter.delete(
  "/api/dashboard/properties/:id/taxes/:taxId",
  requireAuth,
  async (req, res) => {
    try {
      const user = (req as any).user;
      const orgId = user.orgId as string;
      const { id, taxId } = req.params;

      const tax = await prisma.propertyTax.findFirst({
        where: {
          id: taxId,
          propertyId: id,
          property: { organizationId: orgId },
        },
        select: { id: true },
      });

      if (!tax) {
        return res.status(404).json({ ok: false, error: "Tax not found" });
      }

      await prisma.propertyTax.update({
        where: { id: tax.id },
        data: { isActive: false },
      });

      return res.json({ ok: true });
    } catch (error: any) {
      console.error("DELETE tax error", error);
      return res.status(500).json({ ok: false, error: error?.message ?? "Failed to delete tax" });
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