import { Router } from "express";
import type { PrismaClient } from "@prisma/client";
import { requireAuth } from "../middleware/requireAuth";

const ALLOWED_CATEGORIES = new Set([
  "BEACH",
  "RESTAURANT",
  "ATTRACTION",
  "NATURE",
  "SHOPPING",
  "NIGHTLIFE",
  "CULTURE",
  "OTHER",
]);

function optionalText(value: unknown) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text || null;
}

function optionalNumber(value: unknown) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : NaN;
}

function optionalHttpUrl(value: unknown) {
  const text = optionalText(value);
  if (!text) return null;
  if (text.length > 2048) return undefined;

  try {
    const url = new URL(text);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function coordinatesAreValid(latitude: number | null, longitude: number | null) {
  if ((latitude === null) !== (longitude === null)) return false;
  if (latitude === null || longitude === null) return true;
  return latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180;
}

export function buildPropertyNearbyPlacesRouter(prisma: PrismaClient) {
  const router = Router();
  router.use(requireAuth);

  async function getOwnedProperty(propertyId: string, orgId: string) {
    return prisma.property.findFirst({
      where: {
        id: propertyId,
        organizationId: orgId,
        status: { not: "ARCHIVED" },
      },
      select: { id: true },
    });
  }

  router.get("/api/properties/:propertyId/nearby-places", async (req, res) => {
    const user = (req as any).user;
    const property = await getOwnedProperty(req.params.propertyId, user.orgId);

    if (!property) {
      return res.status(404).json({ ok: false, error: "Property not found" });
    }

    const items = await prisma.propertyNearbyPlace.findMany({
      where: { propertyId: property.id },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    });

    return res.json({ ok: true, items });
  });

  router.post("/api/properties/:propertyId/nearby-places", async (req, res) => {
    try {
      const user = (req as any).user;
      const property = await getOwnedProperty(req.params.propertyId, user.orgId);

      if (!property) {
        return res.status(404).json({ ok: false, error: "Property not found" });
      }

      const name = String(req.body?.name ?? "").trim();
      const category = String(req.body?.category ?? "OTHER").toUpperCase();
      const travelTimeMinutes = optionalNumber(req.body?.travelTimeMinutes);
      const latitude = optionalNumber(req.body?.latitude);
      const longitude = optionalNumber(req.body?.longitude);
      const sortOrder = optionalNumber(req.body?.sortOrder);

      if (!name) {
        return res.status(400).json({ ok: false, error: "name is required" });
      }

      if (!ALLOWED_CATEGORIES.has(category)) {
        return res.status(400).json({ ok: false, error: "Invalid category" });
      }

      if ([travelTimeMinutes, latitude, longitude, sortOrder].some(Number.isNaN)) {
        return res.status(400).json({ ok: false, error: "Invalid numeric value" });
      }

      if (!coordinatesAreValid(latitude, longitude)) {
        return res.status(400).json({
          ok: false,
          error: "Invalid latitude/longitude",
        });
      }

      const googleMapsUrl = optionalHttpUrl(req.body?.googleMapsUrl);
      const photoUrl = optionalHttpUrl(req.body?.photoUrl);

      if (googleMapsUrl === undefined || photoUrl === undefined) {
        return res.status(400).json({
          ok: false,
          error: "URLs must use http/https and be at most 2048 characters",
        });
      }

      const item = await prisma.propertyNearbyPlace.create({
        data: {
          propertyId: property.id,
          name,
          category: category as any,
          description: optionalText(req.body?.description),
          distanceText: optionalText(req.body?.distanceText),
          travelTimeMinutes:
            travelTimeMinutes === null ? null : Math.max(0, Math.round(travelTimeMinutes)),
          latitude,
          longitude,
          googleMapsUrl,
          photoUrl,
          sortOrder: sortOrder === null ? 0 : Math.round(sortOrder),
          isActive: req.body?.isActive === undefined ? true : Boolean(req.body.isActive),
        },
      });

      return res.status(201).json({ ok: true, item });
    } catch (error: any) {
      console.error("[nearby-places create error]", error?.message ?? error);
      return res.status(500).json({ ok: false, error: "Failed to create nearby place" });
    }
  });

  router.patch("/api/properties/:propertyId/nearby-places/:placeId", async (req, res) => {
    try {
      const user = (req as any).user;
      const property = await getOwnedProperty(req.params.propertyId, user.orgId);

      if (!property) {
        return res.status(404).json({ ok: false, error: "Property not found" });
      }

      const existing = await prisma.propertyNearbyPlace.findFirst({
        where: { id: req.params.placeId, propertyId: property.id },
      });

      if (!existing) {
        return res.status(404).json({ ok: false, error: "Nearby place not found" });
      }

      const data: any = {};

      if (req.body?.name !== undefined) {
        const name = String(req.body.name).trim();
        if (!name) return res.status(400).json({ ok: false, error: "name is required" });
        data.name = name;
      }

      if (req.body?.category !== undefined) {
        const category = String(req.body.category).toUpperCase();
        if (!ALLOWED_CATEGORIES.has(category)) {
          return res.status(400).json({ ok: false, error: "Invalid category" });
        }
        data.category = category;
      }

      for (const field of ["description", "distanceText"]) {
        if (req.body?.[field] !== undefined) data[field] = optionalText(req.body[field]);
      }

      for (const field of ["googleMapsUrl", "photoUrl"]) {
        if (req.body?.[field] !== undefined) {
          const url = optionalHttpUrl(req.body[field]);
          if (url === undefined) {
            return res.status(400).json({
              ok: false,
              error: `${field} must use http/https and be at most 2048 characters`,
            });
          }
          data[field] = url;
        }
      }

      for (const field of ["travelTimeMinutes", "sortOrder"]) {
        if (req.body?.[field] !== undefined) {
          const value = optionalNumber(req.body[field]);
          if (Number.isNaN(value)) {
            return res.status(400).json({ ok: false, error: `Invalid ${field}` });
          }
          data[field] =
            value === null
              ? field === "sortOrder"
                ? 0
                : null
              : field === "travelTimeMinutes"
                ? Math.max(0, Math.round(value))
                : Math.round(value);
        }
      }

      const hasLatitude = req.body?.latitude !== undefined;
      const hasLongitude = req.body?.longitude !== undefined;

      if (hasLatitude || hasLongitude) {
        const latitude = hasLatitude ? optionalNumber(req.body.latitude) : Number(existing.latitude);
        const longitude = hasLongitude ? optionalNumber(req.body.longitude) : Number(existing.longitude);

        if (Number.isNaN(latitude) || Number.isNaN(longitude)) {
          return res.status(400).json({ ok: false, error: "Invalid coordinates" });
        }

        if (!coordinatesAreValid(latitude, longitude)) {
          return res.status(400).json({
            ok: false,
            error: "Invalid latitude/longitude",
          });
        }

        data.latitude = latitude;
        data.longitude = longitude;
      }

      if (req.body?.isActive !== undefined) data.isActive = Boolean(req.body.isActive);

      const item = await prisma.propertyNearbyPlace.update({
        where: { id: existing.id },
        data,
      });

      return res.json({ ok: true, item });
    } catch (error: any) {
      console.error("[nearby-places update error]", error?.message ?? error);
      return res.status(500).json({ ok: false, error: "Failed to update nearby place" });
    }
  });

  router.delete("/api/properties/:propertyId/nearby-places/:placeId", async (req, res) => {
    const user = (req as any).user;
    const property = await getOwnedProperty(req.params.propertyId, user.orgId);

    if (!property) {
      return res.status(404).json({ ok: false, error: "Property not found" });
    }

    const existing = await prisma.propertyNearbyPlace.findFirst({
      where: { id: req.params.placeId, propertyId: property.id },
      select: { id: true },
    });

    if (!existing) {
      return res.status(404).json({ ok: false, error: "Nearby place not found" });
    }

    await prisma.propertyNearbyPlace.delete({ where: { id: existing.id } });
    return res.json({ ok: true });
  });

  return router;
}
