import "dotenv/config";
import express from "express";
import cors from "cors";
import { PrismaClient } from "@prisma/client";
import { searchPublicStays } from "./services/public-stay-search.service";

const app = express();
const prisma = new PrismaClient();
const PORT = Number(process.env.PORT ?? 3000);
const STAGING_REVISION = "booking-search-staging-v4";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL missing");
app.use(cors({ origin: true, credentials: false }));
app.get("/health", (_req, res) => res.json({ ok: true, service: "pin-go-booking-search-staging", revision: STAGING_REVISION }));
app.get("/ready", async (_req, res) => { try { await prisma.$queryRaw`SELECT 1`; res.json({ ok: true, service: "pin-go-booking-search-staging", revision: STAGING_REVISION }); } catch { res.status(500).json({ ok: false }); } });

app.get("/api/public-booking/catalog", async (_req, res) => {
  try {
    const items = await prisma.property.findMany({
      where: { status: "ACTIVE", isPublicBookable: true, slug: { not: null }, organization: { publicBookingEnabled: true, slug: { not: null } } },
      select: { name: true, slug: true, publicTitle: true, publicPhotos: true, baseNightlyRate: true, maxGuests: true, city: true, region: true, country: true, organization: { select: { slug: true } } },
      orderBy: { createdAt: "asc" }, take: 200,
    });
    return res.json({ ok: true, revision: STAGING_REVISION, results: items.map((p) => ({ organizationSlug: p.organization.slug, propertySlug: p.slug, title: p.publicTitle?.trim() || p.name, city: p.city ?? null, region: p.region ?? null, country: p.country ?? null, maxGuests: p.maxGuests ?? null, baseNightlyRate: p.baseNightlyRate == null ? null : Number(p.baseNightlyRate), photoUrl: Array.isArray(p.publicPhotos) && typeof p.publicPhotos[0] === "string" ? p.publicPhotos[0] : null, bookingPath: p.organization.slug && p.slug ? `/book/${p.organization.slug}/${p.slug}` : null })) });
  } catch (error) { console.error("[booking-search-staging catalog error]", error); return res.status(500).json({ ok: false, error: "PUBLIC_STAY_CATALOG_FAILED" }); }
});

app.get("/api/public-booking/search", async (req, res) => {
  try {
    const result = await searchPublicStays({ destination: String(req.query.destination ?? ""), checkIn: String(req.query.checkIn ?? ""), checkOut: String(req.query.checkOut ?? ""), guests: Number(req.query.guests) });
    if (!result.ok) return res.status(400).json({ ok: false, error: result.code });
    const slugs = result.results.map((p) => p.propertySlug);
    const rates = slugs.length ? await prisma.property.findMany({ where: { slug: { in: slugs } }, select: { slug: true, baseNightlyRate: true } }) : [];
    const rateBySlug = new Map(rates.map((p) => [p.slug, p.baseNightlyRate == null ? null : Number(p.baseNightlyRate)]));
    return res.json({ ...result, results: result.results.map((p) => ({ ...p, baseNightlyRate: rateBySlug.get(p.propertySlug) ?? null })), revision: STAGING_REVISION });
  } catch (error) { console.error("[booking-search-staging search error]", error); return res.status(500).json({ ok: false, error: "PUBLIC_STAY_SEARCH_FAILED" }); }
});

app.listen(PORT, async () => {
  console.log(`[booking-search-staging] listening on ${PORT} revision=${STAGING_REVISION}`);
  try {
    const eligible = await prisma.property.findMany({ where: { status: "ACTIVE", isPublicBookable: true, slug: { not: null }, organization: { publicBookingEnabled: true, slug: { not: null } } }, select: { slug: true, publicTitle: true, name: true, city: true, region: true, baseNightlyRate: true, organization: { select: { slug: true } } }, take: 200 });
    console.log("[booking-search-staging] eligible-public-catalog", { count: eligible.length, properties: eligible.map((p) => ({ organizationSlug: p.organization.slug, propertySlug: p.slug, title: p.publicTitle?.trim() || p.name, city: p.city, region: p.region, baseNightlyRate: p.baseNightlyRate == null ? null : Number(p.baseNightlyRate) })) });
  } catch (error) { console.error("[booking-search-staging] eligible-public-catalog-error", error); }
});
