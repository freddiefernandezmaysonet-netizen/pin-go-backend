import "dotenv/config";
import express from "express";
import cors from "cors";
import { PrismaClient } from "@prisma/client";
import { searchPublicStays } from "./services/public-stay-search.service";

const app = express();
const prisma = new PrismaClient();
const PORT = Number(process.env.PORT ?? 3000);
const STAGING_REVISION = "booking-search-staging-v2";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL missing");
}

app.use(cors({ origin: true, credentials: false }));

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "pin-go-booking-search-staging", revision: STAGING_REVISION });
});

app.get("/ready", async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ ok: true, service: "pin-go-booking-search-staging", revision: STAGING_REVISION });
  } catch (error) {
    console.error("[booking-search-staging ready error]", error);
    res.status(500).json({ ok: false });
  }
});

app.get("/api/public-booking/catalog", async (_req, res) => {
  try {
    const items = await prisma.property.findMany({
      where: {
        status: "ACTIVE",
        isPublicBookable: true,
        slug: { not: null },
        organization: {
          publicBookingEnabled: true,
          slug: { not: null },
        },
      },
      select: {
        name: true,
        slug: true,
        publicTitle: true,
        publicPhotos: true,
        maxGuests: true,
        city: true,
        region: true,
        country: true,
        organization: { select: { slug: true } },
      },
      orderBy: { createdAt: "asc" },
      take: 200,
    });

    return res.json({
      ok: true,
      revision: STAGING_REVISION,
      results: items.map((property) => ({
        organizationSlug: property.organization.slug,
        propertySlug: property.slug,
        title: property.publicTitle?.trim() || property.name,
        city: property.city ?? null,
        region: property.region ?? null,
        country: property.country ?? null,
        maxGuests: property.maxGuests ?? null,
        photoUrl:
          Array.isArray(property.publicPhotos) && typeof property.publicPhotos[0] === "string"
            ? property.publicPhotos[0]
            : null,
        bookingPath:
          property.organization.slug && property.slug
            ? `/book/${property.organization.slug}/${property.slug}`
            : null,
      })),
    });
  } catch (error) {
    console.error("[booking-search-staging catalog error]", error);
    return res.status(500).json({ ok: false, error: "PUBLIC_STAY_CATALOG_FAILED" });
  }
});

app.get("/api/public-booking/search", async (req, res) => {
  try {
    const result = await searchPublicStays({
      destination: String(req.query.destination ?? ""),
      checkIn: String(req.query.checkIn ?? ""),
      checkOut: String(req.query.checkOut ?? ""),
      guests: Number(req.query.guests),
    });

    if (!result.ok) {
      return res.status(400).json({ ok: false, error: result.code });
    }

    return res.json({ ...result, revision: STAGING_REVISION });
  } catch (error) {
    console.error("[booking-search-staging search error]", error);
    return res.status(500).json({
      ok: false,
      error: "PUBLIC_STAY_SEARCH_FAILED",
    });
  }
});

app.listen(PORT, async () => {
  console.log(`[booking-search-staging] listening on ${PORT} revision=${STAGING_REVISION}`);
  try {
    const eligible = await prisma.property.findMany({
      where: {
        status: "ACTIVE",
        isPublicBookable: true,
        slug: { not: null },
        organization: { publicBookingEnabled: true, slug: { not: null } },
      },
      select: {
        slug: true,
        publicTitle: true,
        name: true,
        city: true,
        region: true,
        organization: { select: { slug: true } },
      },
      take: 200,
    });
    console.log("[booking-search-staging] eligible-public-catalog", {
      count: eligible.length,
      properties: eligible.map((property) => ({
        organizationSlug: property.organization.slug,
        propertySlug: property.slug,
        title: property.publicTitle?.trim() || property.name,
        city: property.city,
        region: property.region,
      })),
    });
  } catch (error) {
    console.error("[booking-search-staging] eligible-public-catalog-error", error);
  }
});
