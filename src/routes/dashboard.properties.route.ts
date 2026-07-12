import { Router } from "express";
import crypto from "crypto";
import { AmenityChargeMode, AmenityFeeType, PrismaClient, ReservationStatus } from "@prisma/client";
import { requireAuth } from "../middleware/requireAuth";
import { provisionChannexProperty } from "../services/channex-provisioning.service";
import { syncChannexAvailabilityForProperty } from "../services/channex-availability-sync.service";
import { ingestReservation } from "../services/ingest.service";
import { auditReservationCompleteFlowSafe } from "../services/reservation-complete-flow-audit.service";
import { calculateDirectBookingPricing } from "../services/direct-booking-pricing.service";
import { applyDefaultMarketSeasonsForProperty } from "../services/market-season-template.service";
import { MARKET_SEASON_CATALOG } from "../data/market-season-catalog";
import { provisionProperty } from "../services/property-provisioning.service";
import { applyDefaultHolidayPricingForProperty } from "../services/holiday-pricing-template.service";
import { createMissionControlSnapshotFromAuditEntries } from "../apms/mission-control.mapper";
import type { AuditEntry } from "../apms/audit-types";
import { persistAuditEntry } from "../apms/audit-persistence.service";
import { createDistributionAuditEntry } from "../apms/distribution-audit.mapper";
import { sendManualReservationGuestConfirmation } from "../lib/mailer";
import { sendLoggedEmail } from "../services/email-delivery.service";
import { dispatchPendingCleaningConfirmationForReservation } from "../services/cleaning-confirmation-dispatch.service";

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

function parseOptionalPercent(value: unknown): number | null {
  if (value === undefined || value === null || String(value).trim() === "") {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function parseOptionalInt(value: unknown): number | null {
  if (value === undefined || value === null || String(value).trim() === "") {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : NaN;
}

const PROPERTY_SEASON_TYPES = ["PEAK", "SHOULDER", "LOW"] as const;

type PropertySeasonType = (typeof PROPERTY_SEASON_TYPES)[number];

function parsePropertySeasonType(
  value: unknown,
  fallback: PropertySeasonType = "SHOULDER"
): PropertySeasonType | null {
  const cleanValue = String(value ?? fallback)
    .trim()
    .toUpperCase();

  if (PROPERTY_SEASON_TYPES.includes(cleanValue as PropertySeasonType)) {
    return cleanValue as PropertySeasonType;
  }

  return null;
}

function getAppUrl() {
  return String(process.env.APP_URL ?? "http://localhost:3000")
    .trim()
    .replace(/\/+$/, "");
}

function buildManageReservationUrl(guestToken: string) {
  return `${getAppUrl()}/booking/manage/${encodeURIComponent(guestToken)}`;
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
          distributionEnabled: true,
          dynamicPricingEnabled: true,
          seasonalPricingEnabled: true,
          holidayPricingEnabled: true,
          distributionStatus: true,
          leadTimePricingEnabled: true,
          leadTimeLastMinuteDays: true,
          leadTimeLastMinutePercent: true,

          occupancyPricingEnabled: true,
          occupancyLookaheadDays: true,
          occupancyLowThresholdPercent: true,
          occupancyLowAdjustmentPercent: true,
          occupancyHighThresholdPercent: true,
          occupancyHighAdjustmentPercent: true,

          distributionEnabledAt: true,
          distributionLastSyncedAt: true,
          distributionLastError: true,
          publicTitle: true,
          publicDescription: true,
          publicPhotos: true,
          baseNightlyRate: true,
          minimumNightlyRate: true,
          maximumNightlyRate: true,
          weekendMarkupPercent: true,
          cleaningFee: true,
          maxGuests: true,
          minimumNights: true,
          maximumNights: true,
          checkInTime: true,
          checkOutTime: true,
          organization: {
            select: {
              slug: true,
            },
          },
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
  distributionEnabled,
  dynamicPricingEnabled,
  seasonalPricingEnabled,
  holidayPricingEnabled,
  publicTitle,
  leadTimePricingEnabled,
  leadTimeLastMinuteDays: leadTimeLastMinuteDaysRaw,
  leadTimeLastMinutePercent: leadTimeLastMinutePercentRaw,

  occupancyPricingEnabled,
  occupancyLookaheadDays: occupancyLookaheadDaysRaw,
  occupancyLowThresholdPercent: occupancyLowThresholdPercentRaw,
  occupancyLowAdjustmentPercent: occupancyLowAdjustmentPercentRaw,
  occupancyHighThresholdPercent: occupancyHighThresholdPercentRaw,
  occupancyHighAdjustmentPercent: occupancyHighAdjustmentPercentRaw,

  publicDescription,
  publicPhotos,
  baseNightlyRate: baseNightlyRateRaw,
  minimumNightlyRate: minimumNightlyRateRaw,
  maximumNightlyRate: maximumNightlyRateRaw,
  weekendMarkupPercent: weekendMarkupPercentRaw,
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
const minimumNightlyRate = parseOptionalMoney(minimumNightlyRateRaw);
const maximumNightlyRate = parseOptionalMoney(maximumNightlyRateRaw);
const weekendMarkupPercent = parseOptionalMoney(weekendMarkupPercentRaw);
const parsedLeadTimeLastMinuteDays =
  parseOptionalInt(leadTimeLastMinuteDaysRaw);

const parsedLeadTimeLastMinutePercent =
  parseOptionalPercent(leadTimeLastMinutePercentRaw);
const parsedOccupancyLookaheadDays =
  parseOptionalInt(occupancyLookaheadDaysRaw);

const parsedOccupancyLowThresholdPercent =
  parseOptionalPercent(occupancyLowThresholdPercentRaw);

const parsedOccupancyLowAdjustmentPercent =
  parseOptionalPercent(occupancyLowAdjustmentPercentRaw);

const parsedOccupancyHighThresholdPercent =
  parseOptionalPercent(occupancyHighThresholdPercentRaw);

const parsedOccupancyHighAdjustmentPercent =
  parseOptionalPercent(occupancyHighAdjustmentPercentRaw);
const cleaningFee = parseOptionalMoney(cleaningFeeRaw);
const maxGuests = parseOptionalInt(maxGuestsRaw);
const minimumNights = parseOptionalInt(minimumNightsRaw);
const maximumNights = parseOptionalInt(maximumNightsRaw);

if (Number.isNaN(baseNightlyRate)) {
  return res.status(400).json({ ok: false, error: "baseNightlyRate must be a valid amount" });
}

if (Number.isNaN(minimumNightlyRate)) {
  return res.status(400).json({ ok: false, error: "minimumNightlyRate must be a valid amount" });
}

if (Number.isNaN(maximumNightlyRate)) {
  return res.status(400).json({ ok: false, error: "maximumNightlyRate must be a valid amount" });
}

 if (Number.isNaN(weekendMarkupPercent)) {
    return res.status(400).json({ ok: false, error: "weekendMarkupPercent must be a valid amount" });
  }

if (Number.isNaN(parsedLeadTimeLastMinuteDays)) {
  return res.status(400).json({
    ok: false,
    error: "leadTimeLastMinuteDays must be a valid number",
  });
}

if (Number.isNaN(parsedLeadTimeLastMinutePercent)) {
  return res.status(400).json({
    ok: false,
    error: "leadTimeLastMinutePercent must be a valid amount",
  });
}

if (Number.isNaN(parsedOccupancyLookaheadDays)) {
  return res.status(400).json({
    ok: false,
    error: "occupancyLookaheadDays must be a valid number",
  });
}

if (Number.isNaN(parsedOccupancyLowThresholdPercent)) {
  return res.status(400).json({
    ok: false,
    error: "occupancyLowThresholdPercent must be a valid percent",
  });
}

if (Number.isNaN(parsedOccupancyLowAdjustmentPercent)) {
  return res.status(400).json({
    ok: false,
    error: "occupancyLowAdjustmentPercent must be a valid percent",
  });
}

if (Number.isNaN(parsedOccupancyHighThresholdPercent)) {
  return res.status(400).json({
    ok: false,
    error: "occupancyHighThresholdPercent must be a valid percent",
  });
}

if (Number.isNaN(parsedOccupancyHighAdjustmentPercent)) {
  return res.status(400).json({
    ok: false,
    error: "occupancyHighAdjustmentPercent must be a valid percent",
  });
}

if (
  minimumNightlyRate !== null &&
  maximumNightlyRate !== null &&
  minimumNightlyRate > maximumNightlyRate
) {
  return res.status(400).json({
    ok: false,
    error: "minimumNightlyRate cannot be greater than maximumNightlyRate",
  });
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
  distributionEnabled: true,
  country: true,
  region: true,
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

if (distributionEnabled !== undefined) {
  data.distributionEnabled = Boolean(distributionEnabled);
}

if (dynamicPricingEnabled !== undefined) {
  data.dynamicPricingEnabled = Boolean(dynamicPricingEnabled);
}

if (seasonalPricingEnabled !== undefined) {
  data.seasonalPricingEnabled = Boolean(seasonalPricingEnabled);
}

if (holidayPricingEnabled !== undefined) {
  data.holidayPricingEnabled = Boolean(holidayPricingEnabled);
}

if (leadTimePricingEnabled !== undefined) {
  data.leadTimePricingEnabled = Boolean(leadTimePricingEnabled);
}

if (leadTimeLastMinuteDaysRaw !== undefined) {
  data.leadTimeLastMinuteDays =
    parsedLeadTimeLastMinuteDays ?? 3;
}

if (leadTimeLastMinutePercentRaw !== undefined) {
  data.leadTimeLastMinutePercent =
    parsedLeadTimeLastMinutePercent;
}

if (occupancyPricingEnabled !== undefined) {
  data.occupancyPricingEnabled = Boolean(occupancyPricingEnabled);
}

if (occupancyLookaheadDaysRaw !== undefined) {
  data.occupancyLookaheadDays =
    parsedOccupancyLookaheadDays ?? 30;
}

if (occupancyLowThresholdPercentRaw !== undefined) {
  data.occupancyLowThresholdPercent =
    parsedOccupancyLowThresholdPercent;
}

if (occupancyLowAdjustmentPercentRaw !== undefined) {
  data.occupancyLowAdjustmentPercent =
    parsedOccupancyLowAdjustmentPercent;
}

if (occupancyHighThresholdPercentRaw !== undefined) {
  data.occupancyHighThresholdPercent =
    parsedOccupancyHighThresholdPercent;
}

if (occupancyHighAdjustmentPercentRaw !== undefined) {
  data.occupancyHighAdjustmentPercent =
    parsedOccupancyHighAdjustmentPercent;
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

if (minimumNightlyRateRaw !== undefined) {
  data.minimumNightlyRate = minimumNightlyRate;
}

if (maximumNightlyRateRaw !== undefined) {
  data.maximumNightlyRate = maximumNightlyRate;
}

if (weekendMarkupPercentRaw !== undefined) {
  data.weekendMarkupPercent = weekendMarkupPercent;
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
          distributionEnabled: true,
          dynamicPricingEnabled: true,
          seasonalPricingEnabled: true,
          holidayPricingEnabled: true,
          leadTimePricingEnabled: true,
          leadTimeLastMinuteDays: true,
          leadTimeLastMinutePercent: true,

          occupancyPricingEnabled: true,
          occupancyLookaheadDays: true,
          occupancyLowThresholdPercent: true,
          occupancyLowAdjustmentPercent: true,
          occupancyHighThresholdPercent: true,
          occupancyHighAdjustmentPercent: true,

          distributionStatus: true,
          distributionEnabledAt: true,
          distributionLastSyncedAt: true,
          distributionLastError: true,
          publicTitle: true,
          publicDescription: true,
          publicPhotos: true,
          baseNightlyRate: true,
          minimumNightlyRate: true,
          maximumNightlyRate: true,
          weekendMarkupPercent: true,
          cleaningFee: true,
          maxGuests: true,
          minimumNights: true,
          maximumNights: true,
          checkInTime: true,
          checkOutTime: true,
          organization: {
            select: {
              slug: true,
            },
          },
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

const marketChanged =
  updated.country !== existing.country ||
  updated.region !== existing.region;

let provisioningResult: any = null;

if (marketChanged) {
  try {
    provisioningResult = await provisionProperty(updated.id);
  } catch (provisioningError: any) {
    console.error("[Provisioning Engine]", {
      propertyId: updated.id,
      error: provisioningError?.message ?? provisioningError,
    });
  }
}

      let distributionSyncResult: any = null;

      if (updated.distributionStatus === "ACTIVE") {
        try {
          distributionSyncResult =
            await syncChannexAvailabilityForProperty(updated.id);

          await prisma.property.update({
            where: { id: updated.id },
            data: {
              distributionLastSyncedAt: new Date(),
              distributionLastError: null,
            },
          });
        } catch (syncError: any) {
          await prisma.property.update({
            where: { id: updated.id },
            data: {
              distributionStatus: "FAILED",
              distributionLastError:
                syncError?.message ?? "Failed to sync distribution changes",
            },
          });

          return res.status(500).json({
            ok: false,
            item: {
              ...updated,
              distributionStatus: "FAILED",
              distributionLastError:
                syncError?.message ?? "Failed to sync distribution changes",
            },
            error:
              syncError?.message ?? "Failed to sync distribution changes",
          });
        }
      }

          return res.json({
  ok: true,
  item: updated,
  provisioningResult,
  distributionSyncResult,
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

dashboardPropertiesRouter.get(
  "/api/dashboard/properties/:id/manual-reservations/quote",
  requireAuth,
  async (req, res) => {
    try {
      const user = (req as any).user;
      const orgId = user.orgId as string;
      const { id } = req.params;

      const checkInRaw = String(req.query.checkIn ?? "");
      const checkOutRaw = String(req.query.checkOut ?? "");

      const checkIn = new Date(`${checkInRaw}T00:00:00.000Z`);
      const checkOut = new Date(`${checkOutRaw}T00:00:00.000Z`);

      if (
        !checkInRaw ||
        !checkOutRaw ||
        Number.isNaN(checkIn.getTime()) ||
        Number.isNaN(checkOut.getTime()) ||
        checkOut <= checkIn
      ) {
        return res.status(400).json({
          ok: false,
          error: "Invalid quote date range",
        });
      }

      const property = await prisma.property.findFirst({
        where: {
          id,
          organizationId: orgId,
          status: "ACTIVE",
        },
        select: {
          id: true,
          name: true,
        },
      });

      if (!property) {
        return res.status(404).json({
          ok: false,
          error: "Property not found",
        });
      }

      const pricing = await calculateDirectBookingPricing({
        propertyId: property.id,
        checkIn,
        checkOut,
      });

      const totalAmount = Number((pricing as any).totalAmount ?? 0);
      const currency = String((pricing as any).currency ?? "usd")
        .trim()
        .toLowerCase();

      if (!Number.isFinite(totalAmount) || totalAmount < 0) {
        return res.status(400).json({
          ok: false,
          error: "Pin&Go could not calculate this reservation total.",
        });
      }

      return res.json({
        ok: true,
        item: {
          propertyId: property.id,
          propertyName: property.name,
          checkIn: checkInRaw,
          checkOut: checkOutRaw,
          nights: (pricing as any).nights ?? null,
          currency,
          nightlySubtotal: Number((pricing as any).nightlySubtotal ?? 0),
          cleaningFee: Number((pricing as any).cleaningFee ?? 0),
          amenitiesTotal: Number((pricing as any).amenitiesTotal ?? 0),
          taxesTotal: Number((pricing as any).taxesTotal ?? 0),
          taxableSubtotal: Number((pricing as any).taxableSubtotal ?? 0),
          totalAmount,
          totalAmountCents: Math.round(totalAmount * 100),
          nightlyRates: (pricing as any).nightlyRates ?? [],
          pricingSource: "PIN_GO_PRICING_ENGINE",
        },
      });
    } catch (error: any) {
      console.error("GET manual reservation quote error", error);

      return res.status(500).json({
        ok: false,
        error:
          error?.message ??
          "Failed to calculate manual reservation quote",
      });
    }
  }
);

dashboardPropertiesRouter.post(
  "/api/dashboard/properties/:id/manual-reservations",
  requireAuth,
  async (req, res) => {
    try {
      const user = (req as any).user;
      const orgId = user.orgId as string;
      const { id } = req.params;

      const {
        guestName,
        guestEmail,
        guestPhone,
        checkIn,
        checkOut,
        paymentState,
      } = req.body ?? {};

      const cleanGuestName = String(guestName || "").trim();
      const cleanGuestEmail = String(guestEmail || "").trim() || null;
      const cleanGuestPhone = String(guestPhone || "").trim() || null;
      const cleanPaymentState = String(paymentState || "NONE")
        .trim()
        .toUpperCase();

      if (!cleanGuestName) {
        return res.status(400).json({
          ok: false,
          error: "Guest name is required",
        });
      }

      if (!checkIn || !checkOut) {
        return res.status(400).json({
          ok: false,
          error: "checkIn and checkOut are required",
        });
      }

      if (!["NONE", "PAID"].includes(cleanPaymentState)) {
        return res.status(400).json({
          ok: false,
          error:
            "Invalid paymentState. Manual reservations currently support NONE or PAID.",
        });
      }

      const property = await prisma.property.findFirst({
        where: {
          id,
          organizationId: orgId,
          status: "ACTIVE",
        },
        select: {
          id: true,
          name: true,
        },
      });

      if (!property) {
        return res.status(404).json({
          ok: false,
          error: "Property not found",
        });
      }

      const manualCheckIn = new Date(`${String(checkIn)}T00:00:00.000Z`);
      const manualCheckOut = new Date(`${String(checkOut)}T00:00:00.000Z`);

      if (
        Number.isNaN(manualCheckIn.getTime()) ||
        Number.isNaN(manualCheckOut.getTime()) ||
        manualCheckOut <= manualCheckIn
      ) {
        return res.status(400).json({
          ok: false,
          error: "Invalid manual reservation dates",
        });
      }

      const manualPricing = await calculateDirectBookingPricing({
        propertyId: property.id,
        checkIn: manualCheckIn,
        checkOut: manualCheckOut,
      });

      const manualTotalAmount = Number(
        (manualPricing as any).totalAmount ?? 0
      );

      const manualCurrency = String(
        (manualPricing as any).currency ?? "usd"
      )
        .trim()
        .toLowerCase();

      if (!Number.isFinite(manualTotalAmount) || manualTotalAmount < 0) {
        return res.status(400).json({
          ok: false,
          error: "Pin&Go could not calculate the manual reservation total.",
        });
      }

      if (cleanPaymentState === "PAID" && manualTotalAmount <= 0) {
        return res.status(400).json({
          ok: false,
          error:
            "Pin&Go calculated a zero total. Review the property pricing before marking this reservation as paid.",
        });
      }

      const manualPricingBreakdown = JSON.parse(
        JSON.stringify({
          source: "MANUAL_RESERVATION",
          pricingSource: "PIN_GO_PRICING_ENGINE",
          paymentState: cleanPaymentState,
          nights: (manualPricing as any).nights ?? null,
          nightlyRates: (manualPricing as any).nightlyRates ?? [],
          nightlySubtotal: (manualPricing as any).nightlySubtotal ?? null,
          cleaningFee: (manualPricing as any).cleaningFee ?? 0,
          amenitiesTotal: (manualPricing as any).amenitiesTotal ?? 0,
          taxesTotal: (manualPricing as any).taxesTotal ?? 0,
          taxableSubtotal: (manualPricing as any).taxableSubtotal ?? null,
          totalAmount: manualTotalAmount,
          totalAmountCents: Math.round(manualTotalAmount * 100),
          currency: manualCurrency,
          calculatedAt: new Date().toISOString(),
        })
      );

      const result = await ingestReservation({
        source: "MANUAL",
        propertyId: property.id,
        guestName: cleanGuestName,
        guestEmail: cleanGuestEmail,
        guestPhone: cleanGuestPhone,
        roomName: property.name,
        checkIn: String(checkIn),
        checkOut: String(checkOut),
        paymentState: cleanPaymentState as "NONE" | "PAID",
        externalProvider: "PIN_GO_MANUAL",
        externalId: crypto.randomUUID(),
        externalUpdatedAt: new Date().toISOString(),
        externalRaw: {
          createdFrom: "CALENDAR_V2",
          paymentState: cleanPaymentState,
          pricingSource: "PIN_GO_PRICING_ENGINE",
          totalAmount: manualTotalAmount,
          currency: manualCurrency,
        },
        status: "ACTIVE",
      });

      const manualReservationWithPricing =
        await prisma.reservation.update({
          where: {
            id: result.reservationId,
          },
          data: {
            totalAmount: manualTotalAmount,
            currency: manualCurrency,
            pricingBreakdown: manualPricingBreakdown,
          },
          select: {
            id: true,
            reservationNumber: true,
            guestName: true,
            guestEmail: true,
            checkIn: true,
            checkOut: true,
            guestToken: true,
            totalAmount: true,
            currency: true,
            property: {
              select: {
                name: true,
                timezone: true,
              },
            },
          },
        });

      const manualReservationForEmail = cleanGuestEmail
        ? manualReservationWithPricing
        : null;

      const emailGuestToken =
        manualReservationForEmail?.guestToken ?? result.guestToken ?? null;

      const manageReservationUrl = emailGuestToken
        ? buildManageReservationUrl(emailGuestToken)
        : null;

      if (manualReservationForEmail?.guestEmail) {
        const manualReservationGuestEmailInput = {
          to: manualReservationForEmail.guestEmail,
          reservationNumber: manualReservationForEmail.reservationNumber,
          guestName: manualReservationForEmail.guestName,
          propertyName: manualReservationForEmail.property.name,
          checkIn: manualReservationForEmail.checkIn,
          checkOut: manualReservationForEmail.checkOut,
          propertyTimeZone: manualReservationForEmail.property.timezone,
          manageReservationUrl,
        };

        try {
          const manualGuestEmailDeliveryResult = await sendLoggedEmail({
            prisma,
            type: "MANUAL_RESERVATION_GUEST_CONFIRMATION",
            to: manualReservationForEmail.guestEmail,
            subject: `Your Reservation #${manualReservationForEmail.reservationNumber} is confirmed - ${manualReservationForEmail.property.name}`,
            reservationId: manualReservationForEmail.id,
            propertyId: property.id,
            organizationId: orgId,
            retryPayload: manualReservationGuestEmailInput,
            send: () =>
              sendManualReservationGuestConfirmation(
                manualReservationGuestEmailInput
              ),
          });

          if (!manualGuestEmailDeliveryResult.ok) {
            console.error("[MANUAL_RESERVATION_GUEST_EMAIL_DELIVERY_FAILED]", {
              organizationId: orgId,
              propertyId: property.id,
              reservationId: result.reservationId,
              to: manualReservationForEmail.guestEmail,
              status: manualGuestEmailDeliveryResult.status,
              error: manualGuestEmailDeliveryResult.error,
            });
          }
        } catch (emailError: any) {
          console.error("[MANUAL_RESERVATION_GUEST_EMAIL_ERROR]", {
            organizationId: orgId,
            propertyId: property.id,
            reservationId: result.reservationId,
            to: manualReservationForEmail.guestEmail,
            error: emailError?.message ?? emailError,
          });
        }
      }

      let distributionSyncResult: any = null;

      const distributionStartedAt = new Date();
      const distributionDecisionId = `distribution-engine:${property.id}:manual-reservation:${result.reservationId}`;

      try {
        distributionSyncResult = await syncChannexAvailabilityForProperty(
          property.id
        );

        await prisma.property.update({
          where: { id: property.id },
          data: {
            distributionLastSyncedAt: new Date(),
            distributionLastError: null,
          },
        });

        const distributionCompletedAt = new Date();

        const distributionSyncSucceeded =
          distributionSyncResult &&
          typeof distributionSyncResult === "object" &&
          "ok" in distributionSyncResult
            ? Boolean((distributionSyncResult as any).ok)
            : true;

        const distributionAuditEntry = createDistributionAuditEntry({
          organizationId: orgId,
          propertyId: property.id,
          reservationId: result.reservationId,
          decisionId: distributionDecisionId,
          trigger: "MANUAL_RESERVATION",
          provider: "CHANNEX",
          syncType: "AVAILABILITY",
          startedAt: distributionStartedAt,
          completedAt: distributionCompletedAt,
          result: distributionSyncResult,
          status: distributionSyncSucceeded ? "SUCCESS" : "FAILED",
          severity: distributionSyncSucceeded ? "INFO" : "WARNING",
          eventType: distributionSyncSucceeded
            ? "SYNC_COMPLETED"
            : "SYNC_FAILED",
          reason: distributionSyncSucceeded
            ? "MANUAL_RESERVATION_AVAILABILITY_SYNC_COMPLETED"
            : "MANUAL_RESERVATION_AVAILABILITY_SYNC_FAILED",
          summary: distributionSyncSucceeded
            ? "Distribution Engine synchronized channel availability after manual reservation."
            : "Distribution Engine could not fully synchronize channel availability after manual reservation.",
          rule: "MANUAL_RESERVATION_CHANNEX_AVAILABILITY_SYNC",
          label: "Manual Reservation Channel Availability Sync",
          recommendedAction: distributionSyncSucceeded
            ? undefined
            : "Review Channex availability sync after this manual reservation.",
        });

        try {
          await persistAuditEntry(prisma, distributionAuditEntry);
        } catch (auditPersistenceError: any) {
          console.error("[APMS_DISTRIBUTION_AUTO_SYNC_AUDIT_PERSIST_ERROR]", {
            engine: "Distribution",
            propertyId: property.id,
            reservationId: result.reservationId,
            provider: "CHANNEX",
            syncType: "AVAILABILITY",
            trigger: "MANUAL_RESERVATION",
            decisionId: distributionAuditEntry.decisionId,
            error: auditPersistenceError?.message ?? auditPersistenceError,
          });
        }
      } catch (syncError: any) {
        console.error("POST manual-reservations Channex sync error", syncError);

        await prisma.property.update({
          where: { id: property.id },
          data: {
            distributionLastError:
              syncError?.message ||
              "Failed to sync Channex after manual reservation",
          },
        });

        const distributionCompletedAt = new Date();

        const distributionAuditEntry = createDistributionAuditEntry({
          organizationId: orgId,
          propertyId: property.id,
          reservationId: result.reservationId,
          decisionId: distributionDecisionId,
          trigger: "MANUAL_RESERVATION",
          provider: "CHANNEX",
          syncType: "AVAILABILITY",
          startedAt: distributionStartedAt,
          completedAt: distributionCompletedAt,
          error: syncError,
          status: "FAILED",
          severity: "CRITICAL",
          eventType: "SYNC_FAILED",
          reason: "MANUAL_RESERVATION_AVAILABILITY_SYNC_ERROR",
          summary:
            "Distribution Engine failed to synchronize channel availability after manual reservation.",
          rule: "MANUAL_RESERVATION_CHANNEX_AVAILABILITY_SYNC",
          label: "Manual Reservation Channel Availability Sync",
          recommendedAction:
            "Review Channex availability connection and retry the sync for this reservation.",
        });

        try {
          await persistAuditEntry(prisma, distributionAuditEntry);
        } catch (auditPersistenceError: any) {
          console.error("[APMS_DISTRIBUTION_AUTO_SYNC_AUDIT_PERSIST_ERROR]", {
            engine: "Distribution",
            propertyId: property.id,
            reservationId: result.reservationId,
            provider: "CHANNEX",
            syncType: "AVAILABILITY",
            trigger: "MANUAL_RESERVATION",
            decisionId: distributionAuditEntry.decisionId,
            error: auditPersistenceError?.message ?? auditPersistenceError,
          });
        }
      }

      let cleaningConfirmationDispatchResult: any = null;

      try {
        cleaningConfirmationDispatchResult =
          await dispatchPendingCleaningConfirmationForReservation({
            prisma,
            reservationId: result.reservationId,
          });

        console.log("[MANUAL_RESERVATION_CLEANING_CONFIRMATION_DISPATCH_RESULT]", {
          reservationId: result.reservationId,
          sent: cleaningConfirmationDispatchResult?.sent ?? false,
          skipped: cleaningConfirmationDispatchResult?.skipped ?? false,
          reason: cleaningConfirmationDispatchResult?.reason ?? null,
          confirmationId:
            cleaningConfirmationDispatchResult?.confirmationId ?? null,
        });
      } catch (cleaningDispatchError: any) {
        console.error("[MANUAL_RESERVATION_CLEANING_CONFIRMATION_DISPATCH_ERROR]", {
          reservationId: result.reservationId,
          propertyId: property.id,
          error: cleaningDispatchError?.message ?? cleaningDispatchError,
        });
      }

      const completeFlowAuditResult = await auditReservationCompleteFlowSafe(
        result.reservationId,
        prisma
      );

      if (completeFlowAuditResult) {
        console.log("[MANUAL_RESERVATION_COMPLETE_FLOW_AUDIT_RESULT]", {
          reservationId: completeFlowAuditResult.reservationId,
          propertyId: completeFlowAuditResult.propertyId,
          organizationId: completeFlowAuditResult.organizationId,
          completeFlowStatus: completeFlowAuditResult.completeFlowStatus,
          failedChecks: completeFlowAuditResult.failedChecks.map(
            (check) => check.rule
          ),
          warningChecks: completeFlowAuditResult.warningChecks.map(
            (check) => check.rule
          ),
        });
      }

      return res.json({
        ok: true,
        reservationId: result.reservationId,
        guestToken: result.guestToken,
        accessGrantId: result.accessGrantId ?? null,
        auditEntry: result.auditEntry ?? null,
        paymentState: cleanPaymentState,
        totalAmount:
          manualReservationWithPricing.totalAmount !== null
            ? Number(manualReservationWithPricing.totalAmount)
            : null,
        currency: manualReservationWithPricing.currency ?? manualCurrency,
        distributionSyncResult,
      });
    } catch (error: any) {
      console.error("POST manual reservation error", error);

      return res.status(500).json({
        ok: false,
        error: error?.message ?? "Failed to create manual reservation",
      });
    }
  }
);

dashboardPropertiesRouter.post(
  "/api/dashboard/properties/:id/channex/provision",
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
        },
      });

      if (!property) {
        return res.status(404).json({
          ok: false,
          error: "Property not found",
        });
      }

      const result = await provisionChannexProperty(property.id);

      return res.json({
        ok: true,
        result,
      });
    } catch (error: any) {
      console.error(
        "POST /api/dashboard/properties/:id/channex/provision error",
        error
      );

      return res.status(500).json({
        ok: false,
        error:
          error?.message ??
          "Failed to provision Channex property",
      });
    }
  }
);

dashboardPropertiesRouter.post(
  "/api/dashboard/properties/:id/channex/sync-availability",
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
        },
      });

      if (!property) {
        return res.status(404).json({
          ok: false,
          error: "Property not found",
        });
      }
            const distributionStartedAt = new Date();
      const distributionRunId = distributionStartedAt
        .toISOString()
        .replace(/[:.]/g, "-");

      try {
        const result =
          await syncChannexAvailabilityForProperty(property.id);

        const distributionCompletedAt = new Date();

        const distributionSyncSucceeded =
          result && typeof result === "object" && "ok" in result
            ? Boolean((result as any).ok)
            : true;

       
               const distributionAuditEntry = createDistributionAuditEntry({
          organizationId: orgId,
          propertyId: property.id,
          decisionId: `distribution-engine:${property.id}:channex-availability:${distributionRunId}`,
          trigger: "CHANNEX_AVAILABILITY_SYNC",
          provider: "CHANNEX",
          syncType: "AVAILABILITY",
          startedAt: distributionStartedAt,
          completedAt: distributionCompletedAt,
          result,
          status: distributionSyncSucceeded ? "SUCCESS" : "FAILED",
          severity: distributionSyncSucceeded ? "INFO" : "WARNING",
          eventType: distributionSyncSucceeded
            ? "SYNC_COMPLETED"
            : "SYNC_FAILED",
          reason: distributionSyncSucceeded
            ? "CHANNEX_AVAILABILITY_SYNC_COMPLETED"
            : "CHANNEX_AVAILABILITY_SYNC_FAILED",
          summary: distributionSyncSucceeded
            ? "Distribution Engine synchronized property availability with Channex."
            : "Distribution Engine could not fully synchronize property availability with Channex.",
          rule: "CHANNEX_AVAILABILITY_SYNC",
          label: "Channex Availability Sync",
          recommendedAction: distributionSyncSucceeded
            ? undefined
            : "Review Channex availability sync result for this property.",
        });
       
        try {
          await persistAuditEntry(prisma, distributionAuditEntry);
        } catch (auditPersistenceError: any) {
          console.error("[APMS_DISTRIBUTION_AUDIT_PERSIST_ERROR]", {
            engine: "Distribution",
            propertyId: property.id,
            provider: "CHANNEX",
            syncType: "AVAILABILITY",
            decisionId: distributionAuditEntry.decisionId,
            error:
              auditPersistenceError?.message ??
              auditPersistenceError,
          });
        }

        return res.json({
          ok: true,
          result,
        });
      } catch (syncError: any) {
        const distributionCompletedAt = new Date();

       const distributionAuditEntry = createDistributionAuditEntry({
  organizationId: orgId,
  propertyId: property.id,
  decisionId: `distribution-engine:${property.id}:channex-availability:${distributionRunId}`,
  trigger: "CHANNEX_AVAILABILITY_SYNC",
  provider: "CHANNEX",
  syncType: "AVAILABILITY",
  startedAt: distributionStartedAt,
  completedAt: distributionCompletedAt,
  error: syncError,
  status: "FAILED",
  severity: "CRITICAL",
  eventType: "SYNC_FAILED",
  reason: "CHANNEX_AVAILABILITY_SYNC_ERROR",
  summary:
    "Distribution Engine failed to synchronize property availability with Channex.",
  rule: "CHANNEX_AVAILABILITY_SYNC",
  label: "Channex Availability Sync",
  recommendedAction:
    "Review Channex availability connection and retry the sync.",
});
        try {
          await persistAuditEntry(prisma, distributionAuditEntry);
        } catch (auditPersistenceError: any) {
          console.error("[APMS_DISTRIBUTION_AUDIT_PERSIST_ERROR]", {
            engine: "Distribution",
            propertyId: property.id,
            provider: "CHANNEX",
            syncType: "AVAILABILITY",
            decisionId: distributionAuditEntry.decisionId,
            error:
              auditPersistenceError?.message ??
              auditPersistenceError,
          });
        }

        throw syncError;
      }
     
    } catch (error: any) {
      console.error(
        "POST /api/dashboard/properties/:id/channex/sync-availability error",
        error
      );

      return res.status(500).json({
        ok: false,
        error:
          error?.message ??
          "Failed to sync Channex availability",
      });
    }
  }
);

dashboardPropertiesRouter.get(
  "/api/dashboard/properties/:id/mission-control",
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
          status: "ACTIVE",
        },
        select: {
          id: true,
        },
      });

      if (!property) {
        return res.status(404).json({
          ok: false,
          error: "Property not found",
        });
      }

      const fromRaw = req.query.from;
      const toRaw = req.query.to;

      const today = new Date();
      const defaultFrom = new Date(
        Date.UTC(
          today.getUTCFullYear(),
          today.getUTCMonth(),
          today.getUTCDate()
        )
      );

      const defaultTo = new Date(defaultFrom);
      defaultTo.setUTCDate(defaultTo.getUTCDate() + 30);

      const checkIn = fromRaw
        ? new Date(`${String(fromRaw)}T00:00:00.000Z`)
        : defaultFrom;

      const checkOut = toRaw
        ? new Date(`${String(toRaw)}T00:00:00.000Z`)
        : defaultTo;

      if (
        Number.isNaN(checkIn.getTime()) ||
        Number.isNaN(checkOut.getTime()) ||
        checkOut <= checkIn
      ) {
        return res.status(400).json({
          ok: false,
          error: "Invalid mission-control date range",
        });
      }

             const pricing = await calculateDirectBookingPricing({
        propertyId: property.id,
        checkIn,
        checkOut,
      });

      const revenueAuditEntries = pricing.auditEntries ?? [];

      for (const auditEntry of revenueAuditEntries) {
        try {
          await persistAuditEntry(prisma, {
            ...auditEntry,
            metadata: {
              ...(auditEntry.metadata ?? {}),
              organizationId: orgId,
              propertyId: property.id,
            },
          });
        } catch (auditPersistenceError: any) {
          console.error("[APMS_REVENUE_AUDIT_PERSIST_ERROR]", {
            engine: "Revenue",
            propertyId: property.id,
            decisionId: auditEntry.decisionId,
            error:
              auditPersistenceError?.message ??
              auditPersistenceError,
          });
        }
      }

           const mapPersistedAuditRowToAuditEntry = (
        entry: any
      ): AuditEntry => ({
        engine: entry.engine,
        decisionId: entry.decisionId,
        entityType: entry.entityType as AuditEntry["entityType"],
        entityId: entry.entityId,
        eventType: entry.eventType as AuditEntry["eventType"],
        status: entry.status as AuditEntry["status"],
        severity: entry.severity as AuditEntry["severity"],
        summary: entry.summary ?? undefined,
        startedAt: entry.startedAt ?? entry.createdAt,
        completedAt: entry.completedAt ?? entry.createdAt,
        durationMs: entry.durationMs ?? 0,
        reason: entry.reason ?? undefined,
        decisions: Array.isArray(entry.decisions)
          ? (entry.decisions as AuditEntry["decisions"])
          : undefined,
        recommendedAction: entry.recommendedAction ?? undefined,
        metadata:
          entry.metadata && typeof entry.metadata === "object"
            ? (entry.metadata as Record<string, unknown>)
            : undefined,
      });

            const getAuditEntryReservationId = (
        entry: AuditEntry
      ) => {
        const metadataReservationId =
          typeof entry.metadata?.reservationId === "string"
            ? entry.metadata.reservationId.trim()
            : "";

        if (metadataReservationId) {
          return metadataReservationId;
        }

        if (
          String(entry.entityType ?? "")
            .trim()
            .toUpperCase() === "RESERVATION"
        ) {
          const entityId = String(
            entry.entityId ?? ""
          ).trim();

          return entityId || null;
        }

        return null;
      };

      const persistedNonRevenueAuditRows =
        await prisma.apmsAuditEntry.findMany({
          where: {
            propertyId: property.id,
            engine: {
              not: "Revenue",
            },
          },
          orderBy: [
            {
              completedAt: "desc",
            },
            {
              createdAt: "desc",
            },
          ],
          take: 25,
        });

      const persistedRevenueActivityRows =
        await prisma.apmsAuditEntry.findMany({
          where: {
            propertyId: property.id,
            engine: "Revenue",
          },
          orderBy: [
            {
              completedAt: "desc",
            },
            {
              createdAt: "desc",
            },
          ],
          take: 6,
        });

      const persistedNonRevenueAuditEntries: AuditEntry[] =
        persistedNonRevenueAuditRows.map(
          mapPersistedAuditRowToAuditEntry
        );

      const persistedActivityAuditEntries = [
        ...persistedRevenueActivityRows.map(
          mapPersistedAuditRowToAuditEntry
        ),
        ...persistedNonRevenueAuditEntries,
      ]
        .sort((entryA, entryB) => {
          const entryATime =
            entryA.completedAt?.getTime() ??
            entryA.startedAt?.getTime() ??
            0;

          const entryBTime =
            entryB.completedAt?.getTime() ??
            entryB.startedAt?.getTime() ??
            0;

          return entryBTime - entryATime;
        })
        .slice(0, 10);

      const auditEntriesByDecisionId = new Map<string, AuditEntry>();

      for (const auditEntry of [
        ...revenueAuditEntries,
        ...persistedNonRevenueAuditEntries,
      ]) {
        if (!auditEntriesByDecisionId.has(auditEntry.decisionId)) {
          auditEntriesByDecisionId.set(
            auditEntry.decisionId,
            auditEntry
          );
        }
      }

           const auditEntries = Array.from(
        auditEntriesByDecisionId.values()
      );

      const auditReservationIds = Array.from(
        new Set(
          auditEntries
            .map(getAuditEntryReservationId)
            .filter(
              (reservationId): reservationId is string =>
                Boolean(reservationId)
            )
        )
      );

      const auditReservations =
        auditReservationIds.length > 0
          ? await prisma.reservation.findMany({
              where: {
                id: {
                  in: auditReservationIds,
                },
                propertyId: property.id,
              },
              select: {
                id: true,
                status: true,
              },
            })
          : [];

      const cancelledReservationIds = new Set(
        auditReservations
          .filter(
            (reservation) =>
              reservation.status ===
              ReservationStatus.CANCELLED
          )
          .map((reservation) => reservation.id)
      );

      const activeOperationalAuditEntries =
        auditEntries.filter((entry) => {
          const reservationId =
            getAuditEntryReservationId(entry);

          return (
            !reservationId ||
            !cancelledReservationIds.has(reservationId)
          );
        });

      const baseSnapshot =
        createMissionControlSnapshotFromAuditEntries({
          entityId: property.id,
          auditEntries:
            activeOperationalAuditEntries,
          generatedAt: new Date(),
        });

const recentlyResolvedSince = new Date(
  Date.now() - 7 * 24 * 60 * 60 * 1000
);

const operationalIssueRows =
  await prisma.operationalIssue.findMany({
    where: {
      organizationId: orgId,
      propertyId: property.id,
      visibility: "HOST",
      OR: [
        {
          workflowState: {
            in: [
              "ACTION_REQUIRED",
              "WAITING",
              "AUTO_RESOLVING",
            ],
          },
        },
        {
          workflowState: "RESOLVED",
          resolvedAt: {
            gte: recentlyResolvedSince,
          },
        },
      ],
    },
    orderBy: [
      {
        lastSignalAt: "desc",
      },
    ],
    take: 50,
    select: {
      issueCode: true,

      title: true,
      issue: true,
      operationalImpact: true,
      recommendedAction: true,
      nextAutomaticStep: true,

      engine: true,
      severity: true,
      workflowState: true,
      visibility: true,
      responsibleActor: true,

      actionRequired: true,
      canAutoResolve: true,
      autoResolveStatus: true,

      reservationId: true,
      guestName: true,
      cleanerName: true,

      firstDetectedAt: true,
      lastSignalAt: true,
      resolvedAt: true,

      resolutionCode: true,
      resolutionSummary: true,
      resolutionType: true,
      resolvedBy: true,

      actionTarget: true,
    },
  });

const recommendedActionReservationIds = (
  baseSnapshot.recommendedActions ?? []
)
  .map((action) =>
    String(action.reservationId ?? "").trim()
  )
  .filter(Boolean);

const operationalReservationIds =
  operationalIssueRows
    .map((item) =>
      String(item.reservationId ?? "").trim()
    )
    .filter(Boolean);

const missionControlReservationIds =
  Array.from(
    new Set([
      ...recommendedActionReservationIds,
      ...operationalReservationIds,
    ])
  );

const missionControlReservations =
  missionControlReservationIds.length > 0
    ? await prisma.reservation.findMany({
        where: {
          id: {
            in: missionControlReservationIds,
          },
          propertyId: property.id,
        },
        select: {
          id: true,
          reservationNumber: true,
          guestName: true,
          status: true,
        },
      })
    : [];

const reservationById = new Map(
  missionControlReservations.map(
    (reservation) => [
      reservation.id,
      reservation,
    ]
  )
);

const enrichedRecommendedActions = (
  baseSnapshot.recommendedActions ?? []
).map((action) => {
  const reservationId = String(
    action.reservationId ?? ""
  ).trim();

  const linkedReservation = reservationId
    ? reservationById.get(reservationId)
    : undefined;

  return {
    ...action,
    reservationNumber:
      linkedReservation?.reservationNumber ??
      action.reservationNumber ??
      null,
    guestName:
      linkedReservation?.guestName ??
      action.guestName ??
      null,
  };
});

const operationalItems =
  operationalIssueRows
    .filter((item) => {
      const reservationId = String(
        item.reservationId ?? ""
      ).trim();

      if (!reservationId) {
        return true;
      }

      const linkedReservation =
        reservationById.get(reservationId);

           if (
        linkedReservation?.status ===
        ReservationStatus.CANCELLED
      ) {
        return false;
      }
      return true;
    })
    .map((item) => {
      const reservationId = String(
        item.reservationId ?? ""
      ).trim();

      const linkedReservation = reservationId
        ? reservationById.get(reservationId)
        : undefined;

      return {
        issueCode: item.issueCode,

        title: item.title,
        issue: item.issue,
        operationalImpact:
          item.operationalImpact,
        recommendedAction:
          item.recommendedAction,
        nextAutomaticStep:
          item.nextAutomaticStep,

        engine: item.engine,
        severity: item.severity,
        workflowState: item.workflowState,
        visibility: item.visibility,
        responsibleActor:
          item.responsibleActor,

        actionRequired:
          item.actionRequired,
        canAutoResolve:
          item.canAutoResolve,
        autoResolveStatus:
          item.autoResolveStatus,

        reservationId:
          reservationId || null,
        reservationNumber:
          linkedReservation?.reservationNumber ??
          null,
        guestName:
          linkedReservation?.guestName ??
          item.guestName ??
          null,
        cleanerName:
          item.cleanerName ?? null,

        firstDetectedAt:
          item.firstDetectedAt,
        lastSignalAt:
          item.lastSignalAt,
        resolvedAt:
          item.resolvedAt,

        resolutionCode:
          item.resolutionCode,
        resolutionSummary:
          item.resolutionSummary,
        resolutionType:
          item.resolutionType,
        resolvedBy:
          item.resolvedBy,

        actionTarget:
          item.actionTarget,

        openUrl: reservationId
          ? `/reservations/${reservationId}`
          : null,
        secondaryActionUrl: null,
      };
    });
const snapshot = {
  ...baseSnapshot,
  recommendedActions:
    enrichedRecommendedActions,
  operationalItems,
   recentAuditEntries:
    persistedActivityAuditEntries.length > 0
      ? persistedActivityAuditEntries.filter(
          (entry) => {
            const reservationId =
              getAuditEntryReservationId(entry);

            return (
              !reservationId ||
              !cancelledReservationIds.has(
                reservationId
              )
            );
          }
        )
      : baseSnapshot.recentAuditEntries,
};
      return res.json({
        ok: true,
        item: snapshot,
        pricingWindow: {
          from: checkIn.toISOString().slice(0, 10),
          to: checkOut.toISOString().slice(0, 10),
        },
      });
    } catch (error: any) {
      console.error("GET mission-control error", error);
      return res.status(500).json({
        ok: false,
        error:
          error?.message ??
          "Failed to load property mission control snapshot",
      });
    }
  }
);

dashboardPropertiesRouter.get(
  "/api/dashboard/properties/:id/nightly-rates",
  async (req, res) => {
    try {
      const propertyId = String(req.params.id);

      const fromRaw = req.query.from;
      const toRaw = req.query.to;

      if (!fromRaw || !toRaw) {
        return res.status(400).json({
          ok: false,
          error: "from and to are required",
        });
      }

      const checkIn = new Date(`${String(fromRaw)}T00:00:00.000Z`);
      const checkOut = new Date(`${String(toRaw)}T00:00:00.000Z`);

      const pricing = await calculateDirectBookingPricing({
        propertyId,
        checkIn,
        checkOut,
      });

      return res.json({
        ok: true,
       rates: pricing.nightlyRates.map((rate) => ({
 id: rate.date,
date: rate.date,
rate: rate.rate,
reason: rate.reason,
appliedRules: rate.appliedRules ?? [rate.reason],
pricingBreakdown: rate.pricingBreakdown ?? [],
})),

      });
    } catch (err) {
      console.error("GET nightly-rates error", err);
      return res.status(500).json({
        ok: false,
        error: "Failed to load nightly rates",
      });
    }
  }
);

dashboardPropertiesRouter.put(
  "/api/dashboard/properties/:id/nightly-rates",
  async (req, res) => {
  try {
    const propertyId = String(req.params.id);
    const rates = Array.isArray(req.body?.rates) ? req.body.rates : [];

    if (!rates.length) {
  return res.status(400).json({
    ok: false,
    error: "rates must be a non-empty array",
  });
}
    const property = await prisma.property.findUnique({
  where: { id: propertyId },
  select: {
    id: true,
    organizationId: true,
    minimumNightlyRate: true,
    maximumNightlyRate: true,
  },
});

if (!property) {
  return res.status(404).json({
    ok: false,
    error: "Property not found",
  });
}

const minimumNightlyRate =
  property.minimumNightlyRate != null
    ? Number(property.minimumNightlyRate)
    : null;

const maximumNightlyRate =
  property.maximumNightlyRate != null
    ? Number(property.maximumNightlyRate)
    : null;

    const savedRates = [];

    for (const item of rates) {
      const dateRaw = String(item.date ?? "");
      const rateNumber = Number(item.rate);

      if (!dateRaw || Number.isNaN(rateNumber) || rateNumber < 0) {
        return res.status(400).json({
          ok: false,
          error: "Each rate must include a valid date and rate",
        });
      }

if (minimumNightlyRate !== null && rateNumber < minimumNightlyRate) {
  return res.status(400).json({
    ok: false,
    error: `Rate cannot be lower than minimumNightlyRate (${minimumNightlyRate})`,
  });
}

if (maximumNightlyRate !== null && rateNumber > maximumNightlyRate) {
  return res.status(400).json({
    ok: false,
    error: `Rate cannot be greater than maximumNightlyRate (${maximumNightlyRate})`,
  });
}

      const date = new Date(`${dateRaw}T00:00:00.000Z`);

      const saved = await prisma.propertyNightlyRate.upsert({
        where: {
          propertyId_date: {
            propertyId,
            date,
          },
        },
        update: {
          rate: rateNumber,
          reason: item.reason ?? "MANUAL_OVERRIDE",
        },
        create: {
          propertyId,
          date,
          rate: rateNumber,
          reason: item.reason ?? "MANUAL_OVERRIDE",
        },
        select: {
          id: true,
          date: true,
          rate: true,
          reason: true,
        },
      });

      savedRates.push(saved);
    }

  let distributionSyncResult: any = null;

const distributionStartedAt = new Date();
const distributionRunId = distributionStartedAt
  .toISOString()
  .replace(/[:.]/g, "-");

const distributionDecisionId = `distribution-engine:${propertyId}:nightly-rates:${distributionRunId}`;

const changedRateDates = savedRates.map((rate) =>
  rate.date.toISOString().slice(0, 10)
);

try {
  distributionSyncResult = await syncChannexAvailabilityForProperty(propertyId);

  await prisma.property.update({
    where: { id: propertyId },
    data: {
      distributionLastSyncedAt: new Date(),
      distributionLastError: null,
    },
  });

  const distributionCompletedAt = new Date();

  const distributionSyncSucceeded =
    distributionSyncResult &&
    typeof distributionSyncResult === "object" &&
    "ok" in distributionSyncResult
      ? Boolean((distributionSyncResult as any).ok)
      : true;

 const distributionAuditEntry = createDistributionAuditEntry({
  organizationId: property.organizationId,
  propertyId,
  decisionId: distributionDecisionId,
  trigger: "NIGHTLY_RATE_UPDATE",
  provider: "CHANNEX",
  syncType: "AVAILABILITY",
  startedAt: distributionStartedAt,
  completedAt: distributionCompletedAt,
  result: distributionSyncResult,
  status: distributionSyncSucceeded ? "SUCCESS" : "FAILED",
  severity: distributionSyncSucceeded ? "INFO" : "WARNING",
  eventType: distributionSyncSucceeded ? "SYNC_COMPLETED" : "SYNC_FAILED",
  reason: distributionSyncSucceeded
    ? "NIGHTLY_RATE_DISTRIBUTION_SYNC_COMPLETED"
    : "NIGHTLY_RATE_DISTRIBUTION_SYNC_FAILED",
  summary: distributionSyncSucceeded
    ? "Distribution Engine synchronized channel availability after nightly rate update."
    : "Distribution Engine could not fully synchronize channel availability after nightly rate update.",
  rule: "NIGHTLY_RATE_CHANNEX_AVAILABILITY_SYNC",
  label: "Nightly Rate Channel Availability Sync",
  recommendedAction: distributionSyncSucceeded
    ? undefined
    : "Review Channex sync after this nightly rate update.",
  metadata: {
    changedRateDates,
    ratesCount: savedRates.length,
  },
});
  try {
    await persistAuditEntry(prisma, distributionAuditEntry);
  } catch (auditPersistenceError: any) {
    console.error("[APMS_DISTRIBUTION_AUTO_SYNC_AUDIT_PERSIST_ERROR]", {
      engine: "Distribution",
      propertyId,
      provider: "CHANNEX",
      syncType: "AVAILABILITY",
      trigger: "NIGHTLY_RATE_UPDATE",
      decisionId: distributionAuditEntry.decisionId,
      error: auditPersistenceError?.message ?? auditPersistenceError,
    });
  }
} catch (syncError: any) {
  console.error("PUT nightly-rates Channex sync error", syncError);

  await prisma.property.update({
    where: { id: propertyId },
    data: {
      distributionLastError:
        syncError?.message ||
        "Failed to sync Channex after nightly rate update",
    },
  });

  const distributionCompletedAt = new Date();

const distributionAuditEntry = createDistributionAuditEntry({
  organizationId: property.organizationId,
  propertyId,
  decisionId: distributionDecisionId,
  trigger: "NIGHTLY_RATE_UPDATE",
  provider: "CHANNEX",
  syncType: "AVAILABILITY",
  startedAt: distributionStartedAt,
  completedAt: distributionCompletedAt,
  error: syncError,
  status: "FAILED",
  severity: "CRITICAL",
  eventType: "SYNC_FAILED",
  reason: "NIGHTLY_RATE_DISTRIBUTION_SYNC_ERROR",
  summary:
    "Distribution Engine failed to synchronize channel availability after nightly rate update.",
  rule: "NIGHTLY_RATE_CHANNEX_AVAILABILITY_SYNC",
  label: "Nightly Rate Channel Availability Sync",
  recommendedAction:
    "Review Channex availability connection and retry the sync after this nightly rate update.",
  metadata: {
    changedRateDates,
    ratesCount: savedRates.length,
  },
});
  try {
    await persistAuditEntry(prisma, distributionAuditEntry);
  } catch (auditPersistenceError: any) {
    console.error("[APMS_DISTRIBUTION_AUTO_SYNC_AUDIT_PERSIST_ERROR]", {
      engine: "Distribution",
      propertyId,
      provider: "CHANNEX",
      syncType: "AVAILABILITY",
      trigger: "NIGHTLY_RATE_UPDATE",
      decisionId: distributionAuditEntry.decisionId,
      error: auditPersistenceError?.message ?? auditPersistenceError,
    });
  }
}
return res.json({
  ok: true,
  rates: savedRates.map((rate) => ({
    id: rate.id,
    date: rate.date.toISOString().slice(0, 10),
    rate: Number(rate.rate),
    reason: rate.reason,
  })),
  distributionSyncResult,
});
   } catch (err) {
    console.error("PUT nightly-rates error", err);
    return res.status(500).json({
      ok: false,
      error: "Failed to save nightly rates",
    });
  }
});


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

dashboardPropertiesRouter.post(
  "/api/dashboard/properties/:id/seasons/apply-market-defaults",
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
          status: "ACTIVE",
        },
        select: { id: true },
      });

      if (!property) {
        return res.status(404).json({
          ok: false,
          error: "Property not found",
        });
      }

      const result = await applyDefaultMarketSeasonsForProperty(property.id);
    let distributionSyncResult: any = null;

const distributionStartedAt = new Date();
const distributionRunId = distributionStartedAt
  .toISOString()
  .replace(/[:.]/g, "-");

const distributionDecisionId = `distribution-engine:${property.id}:market-season-defaults:${distributionRunId}`;

try {
  distributionSyncResult = await syncChannexAvailabilityForProperty(
    property.id
  );

  await prisma.property.update({
    where: { id: property.id },
    data: {
      distributionLastSyncedAt: new Date(),
      distributionLastError: null,
    },
  });

  const distributionCompletedAt = new Date();

  const distributionSyncSucceeded =
    distributionSyncResult &&
    typeof distributionSyncResult === "object" &&
    "ok" in distributionSyncResult
      ? Boolean((distributionSyncResult as any).ok)
      : true;

  const distributionAuditEntry = createDistributionAuditEntry({
    organizationId: orgId,
    propertyId: property.id,
    decisionId: distributionDecisionId,
    trigger: "MARKET_SEASON_DEFAULTS",
    provider: "CHANNEX",
    syncType: "AVAILABILITY",
    startedAt: distributionStartedAt,
    completedAt: distributionCompletedAt,
    result: distributionSyncResult,
    status: distributionSyncSucceeded ? "SUCCESS" : "FAILED",
    severity: distributionSyncSucceeded ? "INFO" : "WARNING",
    eventType: distributionSyncSucceeded ? "SYNC_COMPLETED" : "SYNC_FAILED",
    reason: distributionSyncSucceeded
      ? "MARKET_SEASON_DEFAULTS_DISTRIBUTION_SYNC_COMPLETED"
      : "MARKET_SEASON_DEFAULTS_DISTRIBUTION_SYNC_FAILED",
    summary: distributionSyncSucceeded
      ? "Distribution Engine synchronized channel availability after market season defaults were applied."
      : "Distribution Engine could not fully synchronize channel availability after market season defaults were applied.",
    rule: "MARKET_SEASON_DEFAULTS_CHANNEX_AVAILABILITY_SYNC",
    label: "Market Season Defaults Channel Availability Sync",
    recommendedAction: distributionSyncSucceeded
      ? undefined
      : "Review Channex sync after applying market season defaults.",
    metadata: {
      seasonDefaultsApplied: true,
    },
  });

  try {
    await persistAuditEntry(prisma, distributionAuditEntry);
  } catch (auditPersistenceError: any) {
    console.error("[APMS_DISTRIBUTION_AUTO_SYNC_AUDIT_PERSIST_ERROR]", {
      engine: "Distribution",
      propertyId: property.id,
      provider: "CHANNEX",
      syncType: "AVAILABILITY",
      trigger: "MARKET_SEASON_DEFAULTS",
      decisionId: distributionAuditEntry.decisionId,
      error: auditPersistenceError?.message ?? auditPersistenceError,
    });
  }
} catch (syncError: any) {
  console.error("POST apply-market-defaults Channex sync error", syncError);

  await prisma.property.update({
    where: { id: property.id },
    data: {
      distributionLastError:
        syncError?.message ||
        "Failed to sync Channex after applying market season defaults",
    },
  });

  const distributionCompletedAt = new Date();

  const distributionAuditEntry = createDistributionAuditEntry({
    organizationId: orgId,
    propertyId: property.id,
    decisionId: distributionDecisionId,
    trigger: "MARKET_SEASON_DEFAULTS",
    provider: "CHANNEX",
    syncType: "AVAILABILITY",
    startedAt: distributionStartedAt,
    completedAt: distributionCompletedAt,
    error: syncError,
    status: "FAILED",
    severity: "CRITICAL",
    eventType: "SYNC_FAILED",
    reason: "MARKET_SEASON_DEFAULTS_DISTRIBUTION_SYNC_ERROR",
    summary:
      "Distribution Engine failed to synchronize channel availability after market season defaults were applied.",
    rule: "MARKET_SEASON_DEFAULTS_CHANNEX_AVAILABILITY_SYNC",
    label: "Market Season Defaults Channel Availability Sync",
    recommendedAction:
      "Review Channex availability connection and retry sync after applying market season defaults.",
    metadata: {
      seasonDefaultsApplied: true,
    },
  });

  try {
    await persistAuditEntry(prisma, distributionAuditEntry);
  } catch (auditPersistenceError: any) {
    console.error("[APMS_DISTRIBUTION_AUTO_SYNC_AUDIT_PERSIST_ERROR]", {
      engine: "Distribution",
      propertyId: property.id,
      provider: "CHANNEX",
      syncType: "AVAILABILITY",
      trigger: "MARKET_SEASON_DEFAULTS",
      decisionId: distributionAuditEntry.decisionId,
      error: auditPersistenceError?.message ?? auditPersistenceError,
    });
  }
}   
      return res.json({
        ok: true,
        result,
        distributionSyncResult,
      });
    } catch (error: any) {
      console.error("POST apply-market-defaults error", error);
      return res.status(500).json({
        ok: false,
        error:
          error?.message ?? "Failed to apply market default seasons",
      });
    }
  }
);

dashboardPropertiesRouter.post(
  "/api/dashboard/market-season-templates/sync-catalog",
  requireAuth,
  async (req, res) => {
    try {
     let created = 0;
     let updated = 0;
     let skipped = 0;
     let deactivated = 0;
      for (const market of MARKET_SEASON_CATALOG) {
        const catalogSeasonNames = new Set(
  market.seasons.map((season) => season.name)
);
        for (const season of market.seasons) {
          const existing = await prisma.marketSeasonTemplate.findFirst({
            where: {
              country: market.country,
              region: market.region,
              name: season.name,
            },
            select: {
              id: true,
              type: true,
              startMonth: true,
              startDay: true,
              endMonth: true,
              endDay: true,
              adjustmentPercent: true,
              isActive: true,
            },
          });

          if (!existing) {
            await prisma.marketSeasonTemplate.create({
              data: {
                country: market.country,
                region: market.region,
                name: season.name,
                type: season.type,
                startMonth: season.startMonth,
                startDay: season.startDay,
                endMonth: season.endMonth,
                endDay: season.endDay,
                adjustmentPercent: season.adjustmentPercent,
                isActive: true,
              },
            });

            created += 1;
            continue;
          }

          const needsUpdate =
            existing.type !== season.type ||
            Number(existing.startMonth) !== season.startMonth ||
            Number(existing.startDay) !== season.startDay ||
            Number(existing.endMonth) !== season.endMonth ||
            Number(existing.endDay) !== season.endDay ||
            Number(existing.adjustmentPercent) !==
              Number(season.adjustmentPercent) ||
            existing.isActive !== true;

          if (!needsUpdate) {
            skipped += 1;
            continue;
          }

          await prisma.marketSeasonTemplate.update({
            where: { id: existing.id },
            data: {
              type: season.type,
              startMonth: season.startMonth,
              startDay: season.startDay,
              endMonth: season.endMonth,
              endDay: season.endDay,
              adjustmentPercent: season.adjustmentPercent,
              isActive: true,
            },
          });

          updated += 1;
        }
      const deactivateResult = await prisma.marketSeasonTemplate.updateMany({
  where: {
    country: market.country,
    region: market.region ?? null,
    isActive: true,
    name: {
      notIn: Array.from(catalogSeasonNames),
    },
  },
  data: {
    isActive: false,
  },
});

deactivated += deactivateResult.count;

     }

      return res.json({
        ok: true,
        created,
        updated,
        skipped,
        deactivated,
     });
    } catch (error: any) {
      console.error("POST sync market season catalog error", error);
      return res.status(500).json({
        ok: false,
        error:
          error?.message ?? "Failed to sync market season catalog",
      });
    }
  }
);

dashboardPropertiesRouter.get(
  "/api/dashboard/properties/:id/seasons",
  requireAuth,
  async (req, res) => {
    try {
      const user = (req as any).user;
      const orgId = user.orgId as string;
      const { id } = req.params;

      const property = await prisma.property.findFirst({
        where: { id, organizationId: orgId, status: "ACTIVE" },
        select: { id: true },
      });

      if (!property) {
        return res.status(404).json({ ok: false, error: "Property not found" });
      }

      const items = await prisma.propertySeason.findMany({
        where: { propertyId: property.id },
        orderBy: [
          { startMonth: "asc" },
          { startDay: "asc" },
        ],
        select: {
          id: true,
          propertyId: true,
          name: true,
          type: true,
          startMonth: true,
          startDay: true,
          endMonth: true,
          endDay: true,
          adjustmentPercent: true,
          isActive: true,
          source: true,
          createdAt: true,
          updatedAt: true,
        },
      });

      return res.json({
        ok: true,
        items: items.map((item) => ({
          ...item,
          adjustmentPercent: Number(item.adjustmentPercent),
        })),
      });
    } catch (error: any) {
      console.error("GET seasons error", error);
      return res.status(500).json({
        ok: false,
        error: error?.message ?? "Failed to load seasons",
      });
    }
  }
);

dashboardPropertiesRouter.post(
  "/api/dashboard/properties/:id/seasons",
  requireAuth,
  async (req, res) => {
    try {
      const user = (req as any).user;
      const orgId = user.orgId as string;
      const { id } = req.params;

     const {
  name,
  type,
  startMonth,
  startDay,
  endMonth,
  endDay,
  adjustmentPercent,
} = req.body ?? {};
      const cleanName = String(name || "").trim();
      const parsedStartMonth = Number(startMonth);
      const parsedStartDay = Number(startDay);
      const parsedEndMonth = Number(endMonth);
      const parsedEndDay = Number(endDay);
      const parsedAdjustmentPercent = Number(adjustmentPercent);
      const parsedSeasonType = parsePropertySeasonType(type);

      if (!cleanName) {
        return res.status(400).json({ ok: false, error: "Season name is required" });
      }

      if (!parsedSeasonType) {
  return res.status(400).json({
    ok: false,
    error: "type must be PEAK, SHOULDER, or LOW",
  });
}

      if (!Number.isInteger(parsedStartMonth) || parsedStartMonth < 1 || parsedStartMonth > 12) {
        return res.status(400).json({ ok: false, error: "startMonth must be between 1 and 12" });
      }

      if (!Number.isInteger(parsedEndMonth) || parsedEndMonth < 1 || parsedEndMonth > 12) {
        return res.status(400).json({ ok: false, error: "endMonth must be between 1 and 12" });
      }

      if (!Number.isInteger(parsedStartDay) || parsedStartDay < 1 || parsedStartDay > 31) {
        return res.status(400).json({ ok: false, error: "startDay must be between 1 and 31" });
      }

      if (!Number.isInteger(parsedEndDay) || parsedEndDay < 1 || parsedEndDay > 31) {
        return res.status(400).json({ ok: false, error: "endDay must be between 1 and 31" });
      }

      if (!Number.isFinite(parsedAdjustmentPercent) || parsedAdjustmentPercent < -100 || parsedAdjustmentPercent > 300) {
        return res.status(400).json({
          ok: false,
          error: "adjustmentPercent must be between -100 and 300",
        });
      }

      const property = await prisma.property.findFirst({
        where: { id, organizationId: orgId, status: "ACTIVE" },
        select: { id: true },
      });

      if (!property) {
        return res.status(404).json({ ok: false, error: "Property not found" });
      }

      const item = await prisma.propertySeason.create({
        data: {
          propertyId: property.id,
          name: cleanName,
          type: parsedSeasonType,
          startMonth: parsedStartMonth,
          startDay: parsedStartDay,
          endMonth: parsedEndMonth,
          endDay: parsedEndDay,
          adjustmentPercent: parsedAdjustmentPercent,
          isActive: true,
          source: "CUSTOM",
        },
        select: {
          id: true,
          propertyId: true,
          name: true,
          type: true,
          startMonth: true,
          startDay: true,
          endMonth: true,
          endDay: true,
          adjustmentPercent: true,
          isActive: true,
          source: true,
          createdAt: true,
          updatedAt: true,
        },
      });

      await prisma.property.update({
        where: { id: property.id },
        data: { seasonalPricingEnabled: true },
      });

     let distributionSyncResult: any = null;

const distributionStartedAt = new Date();
const distributionDecisionId = `distribution-engine:${property.id}:season-create:${item.id}`;

try {
  distributionSyncResult = await syncChannexAvailabilityForProperty(
    property.id
  );

  await prisma.property.update({
    where: { id: property.id },
    data: {
      distributionLastSyncedAt: new Date(),
      distributionLastError: null,
    },
  });

  const distributionCompletedAt = new Date();

  const distributionSyncSucceeded =
    distributionSyncResult &&
    typeof distributionSyncResult === "object" &&
    "ok" in distributionSyncResult
      ? Boolean((distributionSyncResult as any).ok)
      : true;

  const distributionAuditEntry = createDistributionAuditEntry({
    organizationId: orgId,
    propertyId: property.id,
    decisionId: distributionDecisionId,
    trigger: "SEASON_CREATE",
    provider: "CHANNEX",
    syncType: "AVAILABILITY",
    startedAt: distributionStartedAt,
    completedAt: distributionCompletedAt,
    result: distributionSyncResult,
    status: distributionSyncSucceeded ? "SUCCESS" : "FAILED",
    severity: distributionSyncSucceeded ? "INFO" : "WARNING",
    eventType: distributionSyncSucceeded ? "SYNC_COMPLETED" : "SYNC_FAILED",
    reason: distributionSyncSucceeded
      ? "SEASON_CREATE_DISTRIBUTION_SYNC_COMPLETED"
      : "SEASON_CREATE_DISTRIBUTION_SYNC_FAILED",
    summary: distributionSyncSucceeded
      ? "Distribution Engine synchronized channel availability after seasonal pricing creation."
      : "Distribution Engine could not fully synchronize channel availability after seasonal pricing creation.",
    rule: "SEASON_CREATE_CHANNEX_AVAILABILITY_SYNC",
    label: "Season Creation Channel Availability Sync",
    recommendedAction: distributionSyncSucceeded
      ? undefined
      : "Review Channex sync after creating this season.",
    metadata: {
      seasonId: item.id,
      seasonName: item.name,
      seasonType: item.type,
      seasonSource: item.source,
      adjustmentPercent: Number(item.adjustmentPercent),
      startMonth: item.startMonth,
      startDay: item.startDay,
      endMonth: item.endMonth,
      endDay: item.endDay,
    },
  });

  try {
    await persistAuditEntry(prisma, distributionAuditEntry);
  } catch (auditPersistenceError: any) {
    console.error("[APMS_DISTRIBUTION_AUTO_SYNC_AUDIT_PERSIST_ERROR]", {
      engine: "Distribution",
      propertyId: property.id,
      provider: "CHANNEX",
      syncType: "AVAILABILITY",
      trigger: "SEASON_CREATE",
      seasonId: item.id,
      decisionId: distributionAuditEntry.decisionId,
      error: auditPersistenceError?.message ?? auditPersistenceError,
    });
  }
} catch (syncError: any) {
  console.error("POST seasons Channex sync error", syncError);

  await prisma.property.update({
    where: { id: property.id },
    data: {
      distributionLastError:
        syncError?.message || "Failed to sync Channex after season create",
    },
  });

  const distributionCompletedAt = new Date();

  const distributionAuditEntry = createDistributionAuditEntry({
    organizationId: orgId,
    propertyId: property.id,
    decisionId: distributionDecisionId,
    trigger: "SEASON_CREATE",
    provider: "CHANNEX",
    syncType: "AVAILABILITY",
    startedAt: distributionStartedAt,
    completedAt: distributionCompletedAt,
    error: syncError,
    status: "FAILED",
    severity: "CRITICAL",
    eventType: "SYNC_FAILED",
    reason: "SEASON_CREATE_DISTRIBUTION_SYNC_ERROR",
    summary:
      "Distribution Engine failed to synchronize channel availability after seasonal pricing creation.",
    rule: "SEASON_CREATE_CHANNEX_AVAILABILITY_SYNC",
    label: "Season Creation Channel Availability Sync",
    recommendedAction:
      "Review Channex availability connection and retry sync after creating this season.",
    metadata: {
      seasonId: item.id,
      seasonName: item.name,
      seasonType: item.type,
      seasonSource: item.source,
      adjustmentPercent: Number(item.adjustmentPercent),
      startMonth: item.startMonth,
      startDay: item.startDay,
      endMonth: item.endMonth,
      endDay: item.endDay,
    },
  });

  try {
    await persistAuditEntry(prisma, distributionAuditEntry);
  } catch (auditPersistenceError: any) {
    console.error("[APMS_DISTRIBUTION_AUTO_SYNC_AUDIT_PERSIST_ERROR]", {
      engine: "Distribution",
      propertyId: property.id,
      provider: "CHANNEX",
      syncType: "AVAILABILITY",
      trigger: "SEASON_CREATE",
      seasonId: item.id,
      decisionId: distributionAuditEntry.decisionId,
      error: auditPersistenceError?.message ?? auditPersistenceError,
    });
  }
}
      return res.json({
        ok: true,
        item: {
          ...item,
          adjustmentPercent: Number(item.adjustmentPercent),
        },
        distributionSyncResult,
      });
    } catch (error: any) {
      console.error("POST seasons error", error);
      return res.status(500).json({
        ok: false,
        error: error?.message ?? "Failed to create season",
      });
    }
  }
);

dashboardPropertiesRouter.patch(
  "/api/dashboard/properties/:id/seasons/:seasonId",
  requireAuth,
  async (req, res) => {
    try {
      const user = (req as any).user;
      const orgId = user.orgId as string;
      const { id, seasonId } = req.params;

      const season = await prisma.propertySeason.findFirst({
        where: {
          id: seasonId,
          propertyId: id,
          property: { organizationId: orgId },
        },
        select: { id: true, propertyId: true },
      });

      if (!season) {
        return res.status(404).json({ ok: false, error: "Season not found" });
      }

      const data: any = {};

      if (req.body?.name !== undefined) {
        const cleanName = String(req.body.name || "").trim();
        if (!cleanName) {
          return res.status(400).json({ ok: false, error: "Season name is required" });
        }
        data.name = cleanName;
      }

      if (req.body?.type !== undefined) {
  const parsedSeasonType = parsePropertySeasonType(req.body.type);

  if (!parsedSeasonType) {
    return res.status(400).json({
      ok: false,
      error: "type must be PEAK, SHOULDER, or LOW",
    });
  }

  data.type = parsedSeasonType;
}

      for (const field of ["startMonth", "endMonth"]) {
        if (req.body?.[field] !== undefined) {
          const value = Number(req.body[field]);
          if (!Number.isInteger(value) || value < 1 || value > 12) {
            return res.status(400).json({ ok: false, error: `${field} must be between 1 and 12` });
          }
          data[field] = value;
        }
      }

      for (const field of ["startDay", "endDay"]) {
        if (req.body?.[field] !== undefined) {
          const value = Number(req.body[field]);
          if (!Number.isInteger(value) || value < 1 || value > 31) {
            return res.status(400).json({ ok: false, error: `${field} must be between 1 and 31` });
          }
          data[field] = value;
        }
      }

      if (req.body?.adjustmentPercent !== undefined) {
        const value = Number(req.body.adjustmentPercent);
        if (!Number.isFinite(value) || value < -100 || value > 300) {
          return res.status(400).json({
            ok: false,
            error: "adjustmentPercent must be between -100 and 300",
          });
        }
        data.adjustmentPercent = value;
      }

      if (req.body?.isActive !== undefined) {
        data.isActive = Boolean(req.body.isActive);
      }

      const item = await prisma.propertySeason.update({
        where: { id: season.id },
        data,
        select: {
          id: true,
          propertyId: true,
          name: true,
          type: true,
          startMonth: true,
          startDay: true,
          endMonth: true,
          endDay: true,
          adjustmentPercent: true,
          isActive: true,
          source: true,
          createdAt: true,
          updatedAt: true,
        },
      });

     let distributionSyncResult: any = null;

const distributionStartedAt = new Date();
const distributionRunId = distributionStartedAt
  .toISOString()
  .replace(/[:.]/g, "-");

const distributionDecisionId = `distribution-engine:${season.propertyId}:season-update:${item.id}:${distributionRunId}`;

try {
  distributionSyncResult = await syncChannexAvailabilityForProperty(
    season.propertyId
  );

  await prisma.property.update({
    where: { id: season.propertyId },
    data: {
      distributionLastSyncedAt: new Date(),
      distributionLastError: null,
    },
  });

  const distributionCompletedAt = new Date();

  const distributionSyncSucceeded =
    distributionSyncResult &&
    typeof distributionSyncResult === "object" &&
    "ok" in distributionSyncResult
      ? Boolean((distributionSyncResult as any).ok)
      : true;

  const distributionAuditEntry = createDistributionAuditEntry({
    organizationId: orgId,
    propertyId: season.propertyId,
    decisionId: distributionDecisionId,
    trigger: "SEASON_UPDATE",
    provider: "CHANNEX",
    syncType: "AVAILABILITY",
    startedAt: distributionStartedAt,
    completedAt: distributionCompletedAt,
    result: distributionSyncResult,
    status: distributionSyncSucceeded ? "SUCCESS" : "FAILED",
    severity: distributionSyncSucceeded ? "INFO" : "WARNING",
    eventType: distributionSyncSucceeded ? "SYNC_COMPLETED" : "SYNC_FAILED",
    reason: distributionSyncSucceeded
      ? "SEASON_UPDATE_DISTRIBUTION_SYNC_COMPLETED"
      : "SEASON_UPDATE_DISTRIBUTION_SYNC_FAILED",
    summary: distributionSyncSucceeded
      ? "Distribution Engine synchronized channel availability after seasonal pricing update."
      : "Distribution Engine could not fully synchronize channel availability after seasonal pricing update.",
    rule: "SEASON_UPDATE_CHANNEX_AVAILABILITY_SYNC",
    label: "Season Update Channel Availability Sync",
    recommendedAction: distributionSyncSucceeded
      ? undefined
      : "Review Channex sync after updating this season.",
    metadata: {
      seasonId: item.id,
      seasonName: item.name,
      seasonType: item.type,
      seasonSource: item.source,
      adjustmentPercent: Number(item.adjustmentPercent),
      startMonth: item.startMonth,
      startDay: item.startDay,
      endMonth: item.endMonth,
      endDay: item.endDay,
      isActive: item.isActive,
    },
  });

  try {
    await persistAuditEntry(prisma, distributionAuditEntry);
  } catch (auditPersistenceError: any) {
    console.error("[APMS_DISTRIBUTION_AUTO_SYNC_AUDIT_PERSIST_ERROR]", {
      engine: "Distribution",
      propertyId: season.propertyId,
      provider: "CHANNEX",
      syncType: "AVAILABILITY",
      trigger: "SEASON_UPDATE",
      seasonId: item.id,
      decisionId: distributionAuditEntry.decisionId,
      error: auditPersistenceError?.message ?? auditPersistenceError,
    });
  }
} catch (syncError: any) {
  console.error("PATCH seasons Channex sync error", syncError);

  await prisma.property.update({
    where: { id: season.propertyId },
    data: {
      distributionLastError:
        syncError?.message || "Failed to sync Channex after season update",
    },
  });

  const distributionCompletedAt = new Date();

  const distributionAuditEntry = createDistributionAuditEntry({
    organizationId: orgId,
    propertyId: season.propertyId,
    decisionId: distributionDecisionId,
    trigger: "SEASON_UPDATE",
    provider: "CHANNEX",
    syncType: "AVAILABILITY",
    startedAt: distributionStartedAt,
    completedAt: distributionCompletedAt,
    error: syncError,
    status: "FAILED",
    severity: "CRITICAL",
    eventType: "SYNC_FAILED",
    reason: "SEASON_UPDATE_DISTRIBUTION_SYNC_ERROR",
    summary:
      "Distribution Engine failed to synchronize channel availability after seasonal pricing update.",
    rule: "SEASON_UPDATE_CHANNEX_AVAILABILITY_SYNC",
    label: "Season Update Channel Availability Sync",
    recommendedAction:
      "Review Channex availability connection and retry sync after updating this season.",
    metadata: {
      seasonId: item.id,
      seasonName: item.name,
      seasonType: item.type,
      seasonSource: item.source,
      adjustmentPercent: Number(item.adjustmentPercent),
      startMonth: item.startMonth,
      startDay: item.startDay,
      endMonth: item.endMonth,
      endDay: item.endDay,
      isActive: item.isActive,
    },
  });

  try {
    await persistAuditEntry(prisma, distributionAuditEntry);
  } catch (auditPersistenceError: any) {
    console.error("[APMS_DISTRIBUTION_AUTO_SYNC_AUDIT_PERSIST_ERROR]", {
      engine: "Distribution",
      propertyId: season.propertyId,
      provider: "CHANNEX",
      syncType: "AVAILABILITY",
      trigger: "SEASON_UPDATE",
      seasonId: item.id,
      decisionId: distributionAuditEntry.decisionId,
      error: auditPersistenceError?.message ?? auditPersistenceError,
    });
  }
}
      return res.json({
        ok: true,
        item: {
          ...item,
          adjustmentPercent: Number(item.adjustmentPercent),
        },
        distributionSyncResult,
      });
    } catch (error: any) {
      console.error("PATCH seasons error", error);
      return res.status(500).json({
        ok: false,
        error: error?.message ?? "Failed to update season",
      });
    }
  }
);

dashboardPropertiesRouter.delete(
  "/api/dashboard/properties/:id/seasons/:seasonId",
  requireAuth,
  async (req, res) => {
    try {
      const user = (req as any).user;
      const orgId = user.orgId as string;
      const { id, seasonId } = req.params;

      const season = await prisma.propertySeason.findFirst({
        where: {
          id: seasonId,
          propertyId: id,
          property: { organizationId: orgId },
        },
        select: { id: true, propertyId: true },
      });

      if (!season) {
        return res.status(404).json({ ok: false, error: "Season not found" });
      }

     const item = await prisma.propertySeason.update({
  where: { id: season.id },
  data: { isActive: false },
  select: {
    id: true,
    propertyId: true,
    name: true,
    type: true,
    startMonth: true,
    startDay: true,
    endMonth: true,
    endDay: true,
    adjustmentPercent: true,
    isActive: true,
    source: true,
    createdAt: true,
    updatedAt: true,
  },
});
     let distributionSyncResult: any = null;

const distributionStartedAt = new Date();
const distributionRunId = distributionStartedAt
  .toISOString()
  .replace(/[:.]/g, "-");

const distributionDecisionId = `distribution-engine:${season.propertyId}:season-delete:${item.id}:${distributionRunId}`;

try {
  distributionSyncResult = await syncChannexAvailabilityForProperty(
    season.propertyId
  );

  await prisma.property.update({
    where: { id: season.propertyId },
    data: {
      distributionLastSyncedAt: new Date(),
      distributionLastError: null,
    },
  });

  const distributionCompletedAt = new Date();

  const distributionSyncSucceeded =
    distributionSyncResult &&
    typeof distributionSyncResult === "object" &&
    "ok" in distributionSyncResult
      ? Boolean((distributionSyncResult as any).ok)
      : true;

  const distributionAuditEntry = createDistributionAuditEntry({
    organizationId: orgId,
    propertyId: season.propertyId,
    decisionId: distributionDecisionId,
    trigger: "SEASON_DELETE",
    provider: "CHANNEX",
    syncType: "AVAILABILITY",
    startedAt: distributionStartedAt,
    completedAt: distributionCompletedAt,
    result: distributionSyncResult,
    status: distributionSyncSucceeded ? "SUCCESS" : "FAILED",
    severity: distributionSyncSucceeded ? "INFO" : "WARNING",
    eventType: distributionSyncSucceeded ? "SYNC_COMPLETED" : "SYNC_FAILED",
    reason: distributionSyncSucceeded
      ? "SEASON_DELETE_DISTRIBUTION_SYNC_COMPLETED"
      : "SEASON_DELETE_DISTRIBUTION_SYNC_FAILED",
    summary: distributionSyncSucceeded
      ? "Distribution Engine synchronized channel availability after seasonal pricing removal."
      : "Distribution Engine could not fully synchronize channel availability after seasonal pricing removal.",
    rule: "SEASON_DELETE_CHANNEX_AVAILABILITY_SYNC",
    label: "Season Removal Channel Availability Sync",
    recommendedAction: distributionSyncSucceeded
      ? undefined
      : "Review Channex sync after removing this season.",
    metadata: {
      seasonId: item.id,
      seasonName: item.name,
      seasonType: item.type,
      seasonSource: item.source,
      adjustmentPercent: Number(item.adjustmentPercent),
      startMonth: item.startMonth,
      startDay: item.startDay,
      endMonth: item.endMonth,
      endDay: item.endDay,
      isActive: item.isActive,
    },
  });

  try {
    await persistAuditEntry(prisma, distributionAuditEntry);
  } catch (auditPersistenceError: any) {
    console.error("[APMS_DISTRIBUTION_AUTO_SYNC_AUDIT_PERSIST_ERROR]", {
      engine: "Distribution",
      propertyId: season.propertyId,
      provider: "CHANNEX",
      syncType: "AVAILABILITY",
      trigger: "SEASON_DELETE",
      seasonId: item.id,
      decisionId: distributionAuditEntry.decisionId,
      error: auditPersistenceError?.message ?? auditPersistenceError,
    });
  }
} catch (syncError: any) {
  console.error("DELETE seasons Channex sync error", syncError);

  await prisma.property.update({
    where: { id: season.propertyId },
    data: {
      distributionLastError:
        syncError?.message || "Failed to sync Channex after season delete",
    },
  });

  const distributionCompletedAt = new Date();

  const distributionAuditEntry = createDistributionAuditEntry({
    organizationId: orgId,
    propertyId: season.propertyId,
    decisionId: distributionDecisionId,
    trigger: "SEASON_DELETE",
    provider: "CHANNEX",
    syncType: "AVAILABILITY",
    startedAt: distributionStartedAt,
    completedAt: distributionCompletedAt,
    error: syncError,
    status: "FAILED",
    severity: "CRITICAL",
    eventType: "SYNC_FAILED",
    reason: "SEASON_DELETE_DISTRIBUTION_SYNC_ERROR",
    summary:
      "Distribution Engine failed to synchronize channel availability after seasonal pricing removal.",
    rule: "SEASON_DELETE_CHANNEX_AVAILABILITY_SYNC",
    label: "Season Removal Channel Availability Sync",
    recommendedAction:
      "Review Channex availability connection and retry sync after removing this season.",
    metadata: {
      seasonId: item.id,
      seasonName: item.name,
      seasonType: item.type,
      seasonSource: item.source,
      adjustmentPercent: Number(item.adjustmentPercent),
      startMonth: item.startMonth,
      startDay: item.startDay,
      endMonth: item.endMonth,
      endDay: item.endDay,
      isActive: item.isActive,
    },
  });

  try {
    await persistAuditEntry(prisma, distributionAuditEntry);
  } catch (auditPersistenceError: any) {
    console.error("[APMS_DISTRIBUTION_AUTO_SYNC_AUDIT_PERSIST_ERROR]", {
      engine: "Distribution",
      propertyId: season.propertyId,
      provider: "CHANNEX",
      syncType: "AVAILABILITY",
      trigger: "SEASON_DELETE",
      seasonId: item.id,
      decisionId: distributionAuditEntry.decisionId,
      error: auditPersistenceError?.message ?? auditPersistenceError,
    });
  }
}
      return res.json({
        ok: true,
        distributionSyncResult,
      });
    } catch (error: any) {
      console.error("DELETE seasons error", error);
      return res.status(500).json({
        ok: false,
        error: error?.message ?? "Failed to delete season",
      });
    }
  }
);

dashboardPropertiesRouter.get(
  "/api/dashboard/properties/:id/blocked-dates",
  requireAuth,
  async (req, res) => {
    try {
      const user = (req as any).user;
      const orgId = user.orgId as string;
      const { id } = req.params;

      const property = await prisma.property.findFirst({
        where: { id, organizationId: orgId, status: "ACTIVE" },
        select: { id: true },
      });

      if (!property) {
        return res.status(404).json({ ok: false, error: "Property not found" });
      }

      const items = await prisma.propertyBlockedDate.findMany({
        where: { propertyId: property.id },
        orderBy: { startDate: "asc" },
        select: {
          id: true,
          propertyId: true,
          startDate: true,
          endDate: true,
          reason: true,
          createdAt: true,
          updatedAt: true,
        },
      });

      return res.json({ ok: true, items });
    } catch (error: any) {
      console.error("GET blocked dates error", error);
      return res.status(500).json({
        ok: false,
        error: error?.message ?? "Failed to load blocked dates",
      });
    }
  }
);

  dashboardPropertiesRouter.post(
  "/api/dashboard/properties/:id/distribution/enable",
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
          status: "ACTIVE",
        },
        select: {
          id: true,
          distributionEnabled: true,
        },
      });

      if (!property) {
        return res.status(404).json({
          ok: false,
          error: "Property not found",
        });
      }

      await prisma.property.update({
        where: { id: property.id },
        data: {
          distributionStatus: "ENABLING",
          distributionLastError: null,
        },
      });

      try {
        const provisionResult = await provisionChannexProperty(property.id);
        const syncResult = await syncChannexAvailabilityForProperty(property.id);

        const updated = await prisma.property.update({
          where: { id: property.id },
          data: {
            distributionEnabled: true,
            distributionStatus: "ACTIVE",
            distributionEnabledAt: new Date(),
            distributionLastSyncedAt: new Date(),
            distributionLastError: null,
          },
          select: {
            id: true,
            distributionEnabled: true,
            distributionStatus: true,
            distributionEnabledAt: true,
            distributionLastSyncedAt: true,
            distributionLastError: true,
          },
        });

        return res.json({
          ok: true,
          item: updated,
          distributionSetupResult: {
            provisionResult,
            syncResult,
          },
        });
      } catch (setupError: any) {
        const updated = await prisma.property.update({
          where: { id: property.id },
          data: {
            distributionEnabled: false,
            distributionStatus: "FAILED",
            distributionLastError:
              setupError?.message ?? "Failed to enable property distribution",
          },
          select: {
            id: true,
            distributionEnabled: true,
            distributionStatus: true,
            distributionEnabledAt: true,
            distributionLastSyncedAt: true,
            distributionLastError: true,
          },
        });

        return res.status(500).json({
          ok: false,
          item: updated,
          error:
            setupError?.message ??
            "Failed to enable property distribution",
        });
      }
    } catch (error: any) {
      console.error(
        "POST /api/dashboard/properties/:id/distribution/enable error",
        error
      );

      return res.status(500).json({
        ok: false,
        error:
          error?.message ??
          "Failed to enable property distribution",
      });
    }
  }
);      

 dashboardPropertiesRouter.post(
  "/api/dashboard/properties/:id/blocked-dates",
  requireAuth,
  async (req, res) => {
    try {
      const user = (req as any).user;
      const orgId = user.orgId as string;
      const { id } = req.params;
      const { startDate, endDate, reason } = req.body ?? {};

      const start = new Date(String(startDate ?? ""));
      const end = new Date(String(endDate ?? ""));

      if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
        return res.status(400).json({
          ok: false,
          error: "Invalid startDate/endDate",
        });
      }

      if (end <= start) {
        return res.status(400).json({
          ok: false,
          error: "endDate must be after startDate",
        });
      }

      const property = await prisma.property.findFirst({
        where: { id, organizationId: orgId, status: "ACTIVE" },
        select: { id: true },
      });

      if (!property) {
        return res.status(404).json({ ok: false, error: "Property not found" });
      }

      const reservationConflict = await prisma.reservation.findFirst({
        where: {
          propertyId: property.id,
          status: ReservationStatus.ACTIVE,
          checkIn: { lt: end },
          checkOut: { gt: start },
        },
        select: {
          id: true,
          checkIn: true,
          checkOut: true,
          guestName: true,
        },
      });

      if (reservationConflict) {
        return res.status(409).json({
          ok: false,
          error: "Blocked date overlaps an existing reservation",
          conflict: reservationConflict,
        });
      }

      const blockedDateConflict = await prisma.propertyBlockedDate.findFirst({
        where: {
          propertyId: property.id,
          startDate: { lt: end },
          endDate: { gt: start },
        },
        select: {
          id: true,
          startDate: true,
          endDate: true,
          reason: true,
        },
      });

      if (blockedDateConflict) {
        return res.status(409).json({
          ok: false,
          error: "Blocked date overlaps an existing blocked date",
          conflict: blockedDateConflict,
        });
      }

      const item = await prisma.propertyBlockedDate.create({
        data: {
          propertyId: property.id,
          startDate: start,
          endDate: end,
          reason: String(reason || "").trim() || null,
        },
        select: {
          id: true,
          propertyId: true,
          startDate: true,
          endDate: true,
          reason: true,
          createdAt: true,
          updatedAt: true,
        },
      });
  let distributionSyncResult: any = null;

const distributionStartedAt = new Date();
const distributionDecisionId = `distribution-engine:${property.id}:blocked-date-create:${item.id}`;

const blockedStartDate = item.startDate.toISOString().slice(0, 10);
const blockedEndDate = item.endDate.toISOString().slice(0, 10);

try {
  distributionSyncResult = await syncChannexAvailabilityForProperty(
    property.id
  );

  await prisma.property.update({
    where: { id: property.id },
    data: {
      distributionLastSyncedAt: new Date(),
      distributionLastError: null,
    },
  });

  const distributionCompletedAt = new Date();

  const distributionSyncSucceeded =
    distributionSyncResult &&
    typeof distributionSyncResult === "object" &&
    "ok" in distributionSyncResult
      ? Boolean((distributionSyncResult as any).ok)
      : true;

  const distributionAuditEntry = createDistributionAuditEntry({
    organizationId: orgId,
    propertyId: property.id,
    blockedDateId: item.id,
    decisionId: distributionDecisionId,
    trigger: "BLOCKED_DATE_CREATE",
    provider: "CHANNEX",
    syncType: "AVAILABILITY",
    startedAt: distributionStartedAt,
    completedAt: distributionCompletedAt,
    result: distributionSyncResult,
    status: distributionSyncSucceeded ? "SUCCESS" : "FAILED",
    severity: distributionSyncSucceeded ? "INFO" : "WARNING",
    eventType: distributionSyncSucceeded ? "SYNC_COMPLETED" : "SYNC_FAILED",
    reason: distributionSyncSucceeded
      ? "BLOCKED_DATE_CREATE_DISTRIBUTION_SYNC_COMPLETED"
      : "BLOCKED_DATE_CREATE_DISTRIBUTION_SYNC_FAILED",
    summary: distributionSyncSucceeded
      ? "Distribution Engine synchronized channel availability after blocked date creation."
      : "Distribution Engine could not fully synchronize channel availability after blocked date creation.",
    rule: "BLOCKED_DATE_CREATE_CHANNEX_AVAILABILITY_SYNC",
    label: "Blocked Date Creation Channel Availability Sync",
    recommendedAction: distributionSyncSucceeded
      ? undefined
      : "Review Channex sync after creating this blocked date.",
    metadata: {
      blockedStartDate,
      blockedEndDate,
    },
  });

  try {
    await persistAuditEntry(prisma, distributionAuditEntry);
  } catch (auditPersistenceError: any) {
    console.error("[APMS_DISTRIBUTION_AUTO_SYNC_AUDIT_PERSIST_ERROR]", {
      engine: "Distribution",
      propertyId: property.id,
      blockedDateId: item.id,
      provider: "CHANNEX",
      syncType: "AVAILABILITY",
      trigger: "BLOCKED_DATE_CREATE",
      decisionId: distributionAuditEntry.decisionId,
      error: auditPersistenceError?.message ?? auditPersistenceError,
    });
  }
} catch (syncError: any) {
  console.error("POST blocked-dates Channex sync error", syncError);

  await prisma.property.update({
    where: { id: property.id },
    data: {
      distributionLastError:
        syncError?.message ||
        "Failed to sync Channex after blocked date update",
    },
  });

  const distributionCompletedAt = new Date();

  const distributionAuditEntry = createDistributionAuditEntry({
    organizationId: orgId,
    propertyId: property.id,
    blockedDateId: item.id,
    decisionId: distributionDecisionId,
    trigger: "BLOCKED_DATE_CREATE",
    provider: "CHANNEX",
    syncType: "AVAILABILITY",
    startedAt: distributionStartedAt,
    completedAt: distributionCompletedAt,
    error: syncError,
    status: "FAILED",
    severity: "CRITICAL",
    eventType: "SYNC_FAILED",
    reason: "BLOCKED_DATE_CREATE_DISTRIBUTION_SYNC_ERROR",
    summary:
      "Distribution Engine failed to synchronize channel availability after blocked date creation.",
    rule: "BLOCKED_DATE_CREATE_CHANNEX_AVAILABILITY_SYNC",
    label: "Blocked Date Creation Channel Availability Sync",
    recommendedAction:
      "Review Channex availability connection and retry sync after creating this blocked date.",
    metadata: {
      blockedStartDate,
      blockedEndDate,
    },
  });

  try {
    await persistAuditEntry(prisma, distributionAuditEntry);
  } catch (auditPersistenceError: any) {
    console.error("[APMS_DISTRIBUTION_AUTO_SYNC_AUDIT_PERSIST_ERROR]", {
      engine: "Distribution",
      propertyId: property.id,
      blockedDateId: item.id,
      provider: "CHANNEX",
      syncType: "AVAILABILITY",
      trigger: "BLOCKED_DATE_CREATE",
      decisionId: distributionAuditEntry.decisionId,
      error: auditPersistenceError?.message ?? auditPersistenceError,
    });
  }
} 
return res.json({
  ok: true,
  item,
  distributionSyncResult,
});
    } catch (error: any) {
      console.error("POST blocked dates error", error);

      return res.status(500).json({
        ok: false,
        error: error?.message ?? "Failed to create blocked date",
      });
    }
  }
);
dashboardPropertiesRouter.delete(
  "/api/dashboard/properties/:id/blocked-dates/:blockedDateId",
  requireAuth,
  async (req, res) => {
    try {
      const user = (req as any).user;
      const orgId = user.orgId as string;
      const { id, blockedDateId } = req.params;

      const blockedDate = await prisma.propertyBlockedDate.findFirst({
        where: {
          id: blockedDateId,
          propertyId: id,
          property: {
            organizationId: orgId,
          },
        },
       select: {
  id: true,
  propertyId: true,
  startDate: true,
  endDate: true,
}, 
      });

      if (!blockedDate) {
        return res.status(404).json({
          ok: false,
          error: "Blocked date not found",
        });
      }

      await prisma.propertyBlockedDate.delete({
  where: { id: blockedDate.id },
});
let distributionSyncResult: any = null;

const distributionStartedAt = new Date();
const distributionDecisionId = `distribution-engine:${id}:blocked-date-delete:${blockedDate.id}`;

const blockedStartDate = blockedDate.startDate.toISOString().slice(0, 10);
const blockedEndDate = blockedDate.endDate.toISOString().slice(0, 10);

try {
  distributionSyncResult = await syncChannexAvailabilityForProperty(id);

  await prisma.property.update({
    where: { id },
    data: {
      distributionLastSyncedAt: new Date(),
      distributionLastError: null,
    },
  });

  const distributionCompletedAt = new Date();

  const distributionSyncSucceeded =
    distributionSyncResult &&
    typeof distributionSyncResult === "object" &&
    "ok" in distributionSyncResult
      ? Boolean((distributionSyncResult as any).ok)
      : true;

  const distributionAuditEntry = createDistributionAuditEntry({
    organizationId: orgId,
    propertyId: id,
    blockedDateId: blockedDate.id,
    decisionId: distributionDecisionId,
    trigger: "BLOCKED_DATE_DELETE",
    provider: "CHANNEX",
    syncType: "AVAILABILITY",
    startedAt: distributionStartedAt,
    completedAt: distributionCompletedAt,
    result: distributionSyncResult,
    status: distributionSyncSucceeded ? "SUCCESS" : "FAILED",
    severity: distributionSyncSucceeded ? "INFO" : "WARNING",
    eventType: distributionSyncSucceeded ? "SYNC_COMPLETED" : "SYNC_FAILED",
    reason: distributionSyncSucceeded
      ? "BLOCKED_DATE_DELETE_DISTRIBUTION_SYNC_COMPLETED"
      : "BLOCKED_DATE_DELETE_DISTRIBUTION_SYNC_FAILED",
    summary: distributionSyncSucceeded
      ? "Distribution Engine synchronized channel availability after blocked date removal."
      : "Distribution Engine could not fully synchronize channel availability after blocked date removal.",
    rule: "BLOCKED_DATE_DELETE_CHANNEX_AVAILABILITY_SYNC",
    label: "Blocked Date Removal Channel Availability Sync",
    recommendedAction: distributionSyncSucceeded
      ? undefined
      : "Review Channex sync after removing this blocked date.",
    metadata: {
      blockedStartDate,
      blockedEndDate,
    },
  });

  try {
    await persistAuditEntry(prisma, distributionAuditEntry);
  } catch (auditPersistenceError: any) {
    console.error("[APMS_DISTRIBUTION_AUTO_SYNC_AUDIT_PERSIST_ERROR]", {
      engine: "Distribution",
      propertyId: id,
      blockedDateId: blockedDate.id,
      provider: "CHANNEX",
      syncType: "AVAILABILITY",
      trigger: "BLOCKED_DATE_DELETE",
      decisionId: distributionAuditEntry.decisionId,
      error: auditPersistenceError?.message ?? auditPersistenceError,
    });
  }
} catch (syncError: any) {
  console.error("DELETE blocked-dates Channex sync error", syncError);

  await prisma.property.update({
    where: { id },
    data: {
      distributionLastError:
        syncError?.message ||
        "Failed to sync Channex after blocked date delete",
    },
  });

  const distributionCompletedAt = new Date();

  const distributionAuditEntry = createDistributionAuditEntry({
    organizationId: orgId,
    propertyId: id,
    blockedDateId: blockedDate.id,
    decisionId: distributionDecisionId,
    trigger: "BLOCKED_DATE_DELETE",
    provider: "CHANNEX",
    syncType: "AVAILABILITY",
    startedAt: distributionStartedAt,
    completedAt: distributionCompletedAt,
    error: syncError,
    status: "FAILED",
    severity: "CRITICAL",
    eventType: "SYNC_FAILED",
    reason: "BLOCKED_DATE_DELETE_DISTRIBUTION_SYNC_ERROR",
    summary:
      "Distribution Engine failed to synchronize channel availability after blocked date removal.",
    rule: "BLOCKED_DATE_DELETE_CHANNEX_AVAILABILITY_SYNC",
    label: "Blocked Date Removal Channel Availability Sync",
    recommendedAction:
      "Review Channex availability connection and retry sync after removing this blocked date.",
    metadata: {
      blockedStartDate,
      blockedEndDate,
    },
  });

  try {
    await persistAuditEntry(prisma, distributionAuditEntry);
  } catch (auditPersistenceError: any) {
    console.error("[APMS_DISTRIBUTION_AUTO_SYNC_AUDIT_PERSIST_ERROR]", {
      engine: "Distribution",
      propertyId: id,
      blockedDateId: blockedDate.id,
      provider: "CHANNEX",
      syncType: "AVAILABILITY",
      trigger: "BLOCKED_DATE_DELETE",
      decisionId: distributionAuditEntry.decisionId,
      error: auditPersistenceError?.message ?? auditPersistenceError,
    });
  }
}

return res.json({
  ok: true,
  item: blockedDate,
  distributionSyncResult,
});
       } catch (error: any) {
      console.error("DELETE blocked date error", error);
      return res.status(500).json({
        ok: false,
        error: error?.message ?? "Failed to delete blocked date",
      });
    }
  }
);

dashboardPropertiesRouter.get(
  "/api/dashboard/properties/:id/holiday-pricing",
  requireAuth,
  async (req, res) => {
    try {
      const user = (req as any).user;
      const orgId = user.orgId as string;
      const { id } = req.params;

      const property = await prisma.property.findFirst({
        where: { id, organizationId: orgId, status: "ACTIVE" },
        select: { id: true },
      });

      if (!property) {
        return res.status(404).json({ ok: false, error: "Property not found" });
      }

      const items = await prisma.propertyHolidayPricing.findMany({
        where: { propertyId: property.id },
        orderBy: [
          { startMonth: "asc" },
          { startDay: "asc" },
        ],
        select: {
          id: true,
          propertyId: true,
          name: true,
          startMonth: true,
          startDay: true,
          endMonth: true,
          endDay: true,
          adjustmentPercent: true,
          isActive: true,
          source: true,
          createdAt: true,
          updatedAt: true,
        },
      });

      return res.json({
        ok: true,
        items: items.map((item) => ({
          ...item,
          adjustmentPercent: Number(item.adjustmentPercent),
        })),
      });
    } catch (error: any) {
      console.error("GET holiday pricing error", error);
      return res.status(500).json({
        ok: false,
        error: error?.message ?? "Failed to load holiday pricing",
      });
    }
  }
);

dashboardPropertiesRouter.patch(
  "/api/dashboard/properties/:id/holiday-pricing/:holidayPricingId",
  requireAuth,
  async (req, res) => {
    try {
      const user = (req as any).user;
      const orgId = user.orgId as string;
      const { id, holidayPricingId } = req.params;
      const { adjustmentPercent } = req.body ?? {};

      const parsedAdjustmentPercent = Number(adjustmentPercent);

      if (
        !Number.isFinite(parsedAdjustmentPercent) ||
        parsedAdjustmentPercent < -100 ||
        parsedAdjustmentPercent > 300
      ) {
        return res.status(400).json({
          ok: false,
          error: "adjustmentPercent must be between -100 and 300",
        });
      }

      const holidayPricing = await prisma.propertyHolidayPricing.findFirst({
        where: {
          id: holidayPricingId,
          propertyId: id,
          property: {
            organizationId: orgId,
            status: "ACTIVE",
          },
        },
        select: {
          id: true,
          propertyId: true,
        },
      });

      if (!holidayPricing) {
        return res.status(404).json({
          ok: false,
          error: "Holiday pricing not found",
        });
      }

      const item = await prisma.propertyHolidayPricing.update({
        where: { id: holidayPricing.id },
        data: {
          adjustmentPercent: parsedAdjustmentPercent,
        },
        select: {
          id: true,
          propertyId: true,
          name: true,
          startMonth: true,
          startDay: true,
          endMonth: true,
          endDay: true,
          adjustmentPercent: true,
          isActive: true,
          source: true,
          createdAt: true,
          updatedAt: true,
        },
      });

      let distributionSyncResult: any = null;

      const distributionStartedAt = new Date();
      const distributionRunId = distributionStartedAt
        .toISOString()
        .replace(/[:.]/g, "-");

      const distributionDecisionId = `distribution-engine:${holidayPricing.propertyId}:holiday-pricing-update:${item.id}:${distributionRunId}`;

      try {
        distributionSyncResult = await syncChannexAvailabilityForProperty(
          holidayPricing.propertyId
        );

        await prisma.property.update({
          where: { id: holidayPricing.propertyId },
          data: {
            distributionLastSyncedAt: new Date(),
            distributionLastError: null,
          },
        });

        const distributionCompletedAt = new Date();

        const distributionSyncSucceeded =
          distributionSyncResult &&
          typeof distributionSyncResult === "object" &&
          "ok" in distributionSyncResult
            ? Boolean((distributionSyncResult as any).ok)
            : true;

        const distributionAuditEntry = createDistributionAuditEntry({
          organizationId: orgId,
          propertyId: holidayPricing.propertyId,
          decisionId: distributionDecisionId,
          trigger: "HOLIDAY_PRICING_UPDATE",
          provider: "CHANNEX",
          syncType: "AVAILABILITY",
          startedAt: distributionStartedAt,
          completedAt: distributionCompletedAt,
          result: distributionSyncResult,
          status: distributionSyncSucceeded ? "SUCCESS" : "FAILED",
          severity: distributionSyncSucceeded ? "INFO" : "WARNING",
          eventType: distributionSyncSucceeded
            ? "SYNC_COMPLETED"
            : "SYNC_FAILED",
          reason: distributionSyncSucceeded
            ? "HOLIDAY_PRICING_UPDATE_DISTRIBUTION_SYNC_COMPLETED"
            : "HOLIDAY_PRICING_UPDATE_DISTRIBUTION_SYNC_FAILED",
          summary: distributionSyncSucceeded
            ? "Distribution Engine synchronized channel availability after holiday pricing update."
            : "Distribution Engine could not fully synchronize channel availability after holiday pricing update.",
          rule: "HOLIDAY_PRICING_UPDATE_CHANNEX_AVAILABILITY_SYNC",
          label: "Holiday Pricing Update Channel Availability Sync",
          recommendedAction: distributionSyncSucceeded
            ? undefined
            : "Review Channex sync after updating this holiday pricing rule.",
          metadata: {
            holidayPricingId: item.id,
            holidayName: item.name,
            holidaySource: item.source,
            adjustmentPercent: Number(item.adjustmentPercent),
            startMonth: item.startMonth,
            startDay: item.startDay,
            endMonth: item.endMonth,
            endDay: item.endDay,
            isActive: item.isActive,
          },
        });

        try {
          await persistAuditEntry(prisma, distributionAuditEntry);
        } catch (auditPersistenceError: any) {
          console.error("[APMS_DISTRIBUTION_AUTO_SYNC_AUDIT_PERSIST_ERROR]", {
            engine: "Distribution",
            propertyId: holidayPricing.propertyId,
            provider: "CHANNEX",
            syncType: "AVAILABILITY",
            trigger: "HOLIDAY_PRICING_UPDATE",
            holidayPricingId: item.id,
            decisionId: distributionAuditEntry.decisionId,
            error: auditPersistenceError?.message ?? auditPersistenceError,
          });
        }
      } catch (syncError: any) {
        console.error("PATCH holiday-pricing Channex sync error", syncError);

        await prisma.property.update({
          where: { id: holidayPricing.propertyId },
          data: {
            distributionLastError:
              syncError?.message ||
              "Failed to sync Channex after holiday pricing update",
          },
        });

        const distributionCompletedAt = new Date();

        const distributionAuditEntry = createDistributionAuditEntry({
          organizationId: orgId,
          propertyId: holidayPricing.propertyId,
          decisionId: distributionDecisionId,
          trigger: "HOLIDAY_PRICING_UPDATE",
          provider: "CHANNEX",
          syncType: "AVAILABILITY",
          startedAt: distributionStartedAt,
          completedAt: distributionCompletedAt,
          error: syncError,
          status: "FAILED",
          severity: "CRITICAL",
          eventType: "SYNC_FAILED",
          reason: "HOLIDAY_PRICING_UPDATE_DISTRIBUTION_SYNC_ERROR",
          summary:
            "Distribution Engine failed to synchronize channel availability after holiday pricing update.",
          rule: "HOLIDAY_PRICING_UPDATE_CHANNEX_AVAILABILITY_SYNC",
          label: "Holiday Pricing Update Channel Availability Sync",
          recommendedAction:
            "Review Channex availability connection and retry sync after updating this holiday pricing rule.",
          metadata: {
            holidayPricingId: item.id,
            holidayName: item.name,
            holidaySource: item.source,
            adjustmentPercent: Number(item.adjustmentPercent),
            startMonth: item.startMonth,
            startDay: item.startDay,
            endMonth: item.endMonth,
            endDay: item.endDay,
            isActive: item.isActive,
          },
        });

        try {
          await persistAuditEntry(prisma, distributionAuditEntry);
        } catch (auditPersistenceError: any) {
          console.error("[APMS_DISTRIBUTION_AUTO_SYNC_AUDIT_PERSIST_ERROR]", {
            engine: "Distribution",
            propertyId: holidayPricing.propertyId,
            provider: "CHANNEX",
            syncType: "AVAILABILITY",
            trigger: "HOLIDAY_PRICING_UPDATE",
            holidayPricingId: item.id,
            decisionId: distributionAuditEntry.decisionId,
            error: auditPersistenceError?.message ?? auditPersistenceError,
          });
        }
      }

      return res.json({
        ok: true,
        item: {
          ...item,
          adjustmentPercent: Number(item.adjustmentPercent),
        },
        distributionSyncResult,
      });
    } catch (error: any) {
      console.error("PATCH holiday pricing error", error);
      return res.status(500).json({
        ok: false,
        error: error?.message ?? "Failed to update holiday pricing",
      });
    }
  }
);

dashboardPropertiesRouter.post(
  "/api/dashboard/properties/:id/holiday-pricing/apply-defaults",
  requireAuth,
  async (req, res) => {
    try {
      const user = (req as any).user;
      const orgId = user.orgId as string;
      const { id } = req.params;

      const property = await prisma.property.findFirst({
        where: { id, organizationId: orgId, status: "ACTIVE" },
        select: { id: true },
      });

      if (!property) {
        return res.status(404).json({ ok: false, error: "Property not found" });
      }

      const result = await applyDefaultHolidayPricingForProperty(property.id);

      return res.json({
        ok: true,
        result,
      });
    } catch (error: any) {
      console.error("POST apply holiday pricing defaults error", error);
      return res.status(500).json({
        ok: false,
        error: error?.message ?? "Failed to apply holiday pricing defaults",
      });
    }
  }
);
