import { Router } from "express";
import crypto from "crypto";
import { AmenityChargeMode, AmenityFeeType, PrismaClient, ReservationStatus } from "@prisma/client";
import { requireAuth } from "../middleware/requireAuth";
import { provisionChannexProperty } from "../services/channex-provisioning.service";
import { syncChannexAvailabilityForProperty } from "../services/channex-availability-sync.service";
import { ingestReservation } from "../services/ingest.service";

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
          distributionEnabled: true,
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
  publicTitle,
  publicDescription,
  publicPhotos,
  baseNightlyRate: baseNightlyRateRaw,
  minimumNightlyRate: minimumNightlyRateRaw,
  maximumNightlyRate: maximumNightlyRateRaw,
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
      const cleanPaymentState = String(paymentState || "NONE").trim();

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

      if (!["NONE", "PAID", "PENDING"].includes(cleanPaymentState)) {
        return res.status(400).json({
          ok: false,
          error: "Invalid paymentState",
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

      const result = await ingestReservation({
        source: "MANUAL",
        propertyId: property.id,
        guestName: cleanGuestName,
        guestEmail: cleanGuestEmail,
        guestPhone: cleanGuestPhone,
        roomName: property.name,
        checkIn: String(checkIn),
        checkOut: String(checkOut),
        paymentState: cleanPaymentState as "NONE" | "PAID" | "PENDING",
        externalProvider: "PIN_GO_MANUAL",
        externalId: crypto.randomUUID(),
        externalUpdatedAt: new Date().toISOString(),
        externalRaw: {
          createdFrom: "CALENDAR_V2",
          paymentState: cleanPaymentState,
        },
        status: "ACTIVE",
      });

      let distributionSyncResult: any = null;

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
      }

      return res.json({
        ok: true,
        reservationId: result.reservationId,
        guestToken: result.guestToken,
        accessGrantId: result.accessGrantId ?? null,
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

      const result =
        await syncChannexAvailabilityForProperty(property.id);

      return res.json({
        ok: true,
        result,
      });
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
  "/api/dashboard/properties/:id/nightly-rates",
  async (req, res) => {
  try {
   const propertyId = String(req.params.id);

const fromRaw = req.query.from;
const toRaw = req.query.to;

const where: any = {
  propertyId,
};


if (fromRaw || toRaw) {
  where.date = {};

  if (fromRaw) {
    where.date.gte = new Date(`${String(fromRaw)}T00:00:00.000Z`);
  }

  if (toRaw) {
    where.date.lte = new Date(`${String(toRaw)}T23:59:59.999Z`);
  }
}

const rates = await prisma.propertyNightlyRate.findMany({
  where,
      orderBy: { date: "asc" },
      select: {
        id: true,
        date: true,
        rate: true,
        reason: true,
      },
    });

    return res.json({
      ok: true,
      rates: rates.map((rate) => ({
        id: rate.id,
        date: rate.date.toISOString().slice(0, 10),
        rate: Number(rate.rate),
        reason: rate.reason,
      })),
    });
  } catch (err) {
    console.error("GET nightly-rates error", err);
    return res.status(500).json({
      ok: false,
      error: "Failed to load nightly rates",
    });
   }
});

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

try {
  distributionSyncResult = await syncChannexAvailabilityForProperty(propertyId);

  await prisma.property.update({
    where: { id: propertyId },
    data: {
      distributionLastSyncedAt: new Date(),
      distributionLastError: null,
    },
  });
} catch (syncError: any) {
  console.error("PUT nightly-rates Channex sync error", syncError);

  await prisma.property.update({
    where: { id: propertyId },
    data: {
      distributionLastError:
        syncError?.message || "Failed to sync Channex after nightly rate update",
    },
  });
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

try {
  distributionSyncResult = await syncChannexAvailabilityForProperty(property.id);

  await prisma.property.update({
    where: { id: property.id },
    data: {
      distributionLastSyncedAt: new Date(),
      distributionLastError: null,
    },
  });
} catch (syncError: any) {
  console.error("POST blocked-dates Channex sync error", syncError);

  await prisma.property.update({
    where: { id: property.id },
    data: {
      distributionLastError:
        syncError?.message || "Failed to sync Channex after blocked date update",
    },
  });
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

try {
  distributionSyncResult = await syncChannexAvailabilityForProperty(id);

  await prisma.property.update({
    where: { id },
    data: {
      distributionLastSyncedAt: new Date(),
      distributionLastError: null,
    },
  });
} catch (syncError: any) {
  console.error("DELETE blocked-dates Channex sync error", syncError);

  await prisma.property.update({
    where: { id },
    data: {
      distributionLastError:
        syncError?.message || "Failed to sync Channex after blocked date delete",
    },
  });
}

return res.json({
  ok: true,
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