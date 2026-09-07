import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "path";
import fs from "fs";
import { PrismaClient } from "@prisma/client";
import { searchPublicStays } from "./services/public-stay-search.service";

const app = express();
const prisma = new PrismaClient();
const PORT = Number(process.env.PORT ?? 3000);
const STAGING_REVISION = "booking-search-staging-v12-enterprise-featured-ranking";
const FEATURED_LIMIT = 6;
const POPULAR_MIN_COMPLETED_STAYS_365 = 3;
const POPULAR_TOP_FRACTION = 0.25;
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL missing");
app.use(cors({ origin: true, credentials: false }));

const publicPropertyWhere = {
  status: "ACTIVE" as const,
  isPublicBookable: true,
  slug: { not: null },
  organization: { publicBookingEnabled: true, slug: { not: null } },
};

function publicPropertySelect() {
  return {
    id: true, name: true, slug: true, publicTitle: true, publicPhotos: true,
    baseNightlyRate: true, maxGuests: true, minimumNights: true, maximumNights: true,
    city: true, region: true, country: true, organization: { select: { slug: true } },
  } as const;
}

function publicPropertyPayload(p: any) {
  return {
    organizationSlug: p.organization.slug,
    propertySlug: p.slug,
    title: p.publicTitle?.trim() || p.name,
    city: p.city ?? null,
    region: p.region ?? null,
    country: p.country ?? null,
    maxGuests: p.maxGuests ?? null,
    minimumNights: p.minimumNights,
    maximumNights: p.maximumNights ?? null,
    baseNightlyRate: p.baseNightlyRate == null ? null : Number(p.baseNightlyRate),
    photoUrl: Array.isArray(p.publicPhotos) && typeof p.publicPhotos[0] === "string" ? p.publicPhotos[0] : null,
    bookingPath: p.organization.slug && p.slug ? `/book/${p.organization.slug}/${p.slug}` : null,
  };
}

app.get("/", (_q, res) => {
  const file = path.resolve(process.cwd(), "src/booking-search.preview.html");
  let html = fs.readFileSync(file, "utf8");
  const enhancement = `<style>.featuredbadge{display:block!important;width:max-content}.reviewrating{margin:7px 0 10px;color:#173d32;font-size:14px;font-weight:800}.reviewrating span{color:#66736e;font-weight:600}</style><script>(function(){if(typeof card!=='function')return;var baseCard=card;card=function(p){var markup=baseCard(p);var count=Number(p&&p.reviewCount);var rating=Number(p&&p.averageRating);if(!(count>0)||!Number.isFinite(rating))return markup;var reviewWord=document.documentElement.lang==='en'?(count===1?'review':'reviews'):(count===1?'reseña':'reseñas');var reviewHtml='<div class="reviewrating">★ '+rating.toFixed(1)+' <span>· '+count+' '+reviewWord+'</span></div>';return markup.replace('</h3>','</h3>'+reviewHtml);};})();</script>`;
  html = html.replace("</body>", enhancement + "</body>");
  res.type("html").send(html);
});

app.get("/robots.txt", (_q, res) => {
  res.type("text/plain").send("User-agent: *\nAllow: /\nDisallow: /api/\nSitemap: https://book.pin-ngo.com/sitemap.xml\n");
});
app.get("/sitemap.xml", (_q, res) => {
  res.type("application/xml").send('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://book.pin-ngo.com/</loc></url></urlset>');
});
app.get(["/favicon.ico", "/apple-touch-icon.png", "/apple-touch-icon-precomposed.png"], (_q, res) => {
  res.redirect(302, "https://pin-ngo.com/favicon.ico");
});

app.get("/health", (_q, r) => r.json({ ok: true, service: "pin-go-booking-search-staging", revision: STAGING_REVISION }));
app.get("/ready", async (_q, r) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    r.json({ ok: true, service: "pin-go-booking-search-staging", revision: STAGING_REVISION });
  } catch {
    r.status(500).json({ ok: false });
  }
});

app.get("/api/public-booking/catalog", async (_q, res) => {
  try {
    const items = await prisma.property.findMany({
      where: publicPropertyWhere,
      select: publicPropertySelect(),
      orderBy: { createdAt: "asc" },
      take: 200,
    });
    return res.json({ ok: true, revision: STAGING_REVISION, results: items.map(publicPropertyPayload) });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: "PUBLIC_STAY_CATALOG_FAILED" });
  }
});

app.get("/api/public-booking/featured-audit", async (_q, res) => {
  try {
    const now = new Date();
    const since = new Date(now.getTime() - 365 * 86_400_000);
    const items = await prisma.property.findMany({
      where: publicPropertyWhere,
      select: publicPropertySelect(),
      orderBy: { createdAt: "asc" },
      take: 200,
    });

    const metrics = await Promise.all(items.map(async (p: any) => {
      let reviewCount = 0;
      let averageRating: number | null = null;
      try {
        const reviewWhere = { propertyId: p.id, status: "PUBLISHED" as const, source: "PIN_GO_DIRECT" as const };
        const [count, aggregate] = await Promise.all([
          prisma.propertyReview.count({ where: reviewWhere }),
          prisma.propertyReview.aggregate({ where: reviewWhere, _avg: { overallRating: true } }),
        ]);
        reviewCount = count;
        averageRating = aggregate._avg.overallRating == null ? null : Number(aggregate._avg.overallRating);
      } catch (reviewError) {
        console.warn("[booking-featured-audit] review metrics unavailable", {
          propertyId: p.id,
          error: reviewError instanceof Error ? reviewError.message : String(reviewError),
        });
      }

      const completedStays365 = await prisma.reservation.count({
        where: { propertyId: p.id, status: "ACTIVE", checkOut: { gte: since, lt: now } },
      });
      const readinessScore =
        (p.publicTitle?.trim() ? 2 : 0) +
        (Array.isArray(p.publicPhotos) && typeof p.publicPhotos[0] === "string" ? 2 : 0) +
        (p.baseNightlyRate != null && Number(p.baseNightlyRate) > 0 ? 1 : 0) +
        (p.city ? 1 : 0);

      return {
        ...publicPropertyPayload(p),
        reviewCount,
        averageRating,
        completedStays365,
        readinessScore,
      };
    }));

    const popularityCandidates = metrics
      .filter(p => p.completedStays365 >= POPULAR_MIN_COMPLETED_STAYS_365)
      .sort((a, b) => b.completedStays365 - a.completedStays365 || (b.averageRating ?? 0) - (a.averageRating ?? 0));
    const popularCount = popularityCandidates.length
      ? Math.max(1, Math.ceil(metrics.length * POPULAR_TOP_FRACTION))
      : 0;
    const popularPropertySlugs = new Set(popularityCandidates.slice(0, popularCount).map(p => p.propertySlug));

    const ranked = metrics.map(p => {
      const guestFavorite = p.reviewCount >= 3 && p.averageRating != null && p.averageRating >= 4.8;
      const popular = !guestFavorite && popularPropertySlugs.has(p.propertySlug);
      const featuredReason = guestFavorite ? "GUEST_FAVORITE" : popular ? "POPULAR" : "PIN_GO_PICK";
      const featuredTier = guestFavorite ? 0 : popular ? 1 : 2;
      return { ...p, featuredReason, featuredTier };
    });

    ranked.sort((a, b) =>
      a.featuredTier - b.featuredTier ||
      (b.averageRating ?? 0) - (a.averageRating ?? 0) ||
      b.reviewCount - a.reviewCount ||
      b.completedStays365 - a.completedStays365 ||
      b.readinessScore - a.readinessScore ||
      a.title.localeCompare(b.title)
    );

    return res.json({
      ok: true,
      revision: STAGING_REVISION,
      windowDays: 365,
      featuredLimit: FEATURED_LIMIT,
      guestFavoriteRule: { minimumPublishedReviews: 3, minimumAverageRating: 4.8 },
      popularRule: {
        minimumCompletedStays365: POPULAR_MIN_COMPLETED_STAYS_365,
        topFraction: POPULAR_TOP_FRACTION,
      },
      results: ranked.slice(0, FEATURED_LIMIT),
    });
  } catch (e) {
    console.error("[booking-featured-audit] failed", e);
    return res.status(500).json({ ok: false, error: "PUBLIC_FEATURED_AUDIT_FAILED" });
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
    if (!result.ok) return res.status(400).json({ ok: false, error: result.code });

    const slugs = result.results.map(p => p.propertySlug);
    const rates = slugs.length
      ? await prisma.property.findMany({ where: { slug: { in: slugs } }, select: { slug: true, baseNightlyRate: true } })
      : [];
    const rateMap = new Map(rates.map(p => [p.slug, p.baseNightlyRate == null ? null : Number(p.baseNightlyRate)]));

    return res.json({
      ...result,
      results: result.results.map(p => ({ ...p, baseNightlyRate: rateMap.get(p.propertySlug) ?? null })),
      revision: STAGING_REVISION,
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: "PUBLIC_STAY_SEARCH_FAILED" });
  }
});

app.listen(PORT, async () => {
  console.log(`[booking-search-staging] listening on ${PORT} revision=${STAGING_REVISION}`);
  try {
    const x = await prisma.property.findMany({
      where: publicPropertyWhere,
      select: {
        id: true, slug: true, publicTitle: true, name: true, city: true, region: true,
        timezone: true, baseNightlyRate: true, minimumNights: true, maximumNights: true,
        organization: { select: { slug: true } },
      },
      take: 200,
    });
    console.log("[booking-search-staging] eligible-public-catalog", {
      count: x.length,
      properties: x.map(p => ({
        organizationSlug: p.organization.slug,
        propertySlug: p.slug,
        title: p.publicTitle?.trim() || p.name,
        city: p.city,
        region: p.region,
        baseNightlyRate: p.baseNightlyRate == null ? null : Number(p.baseNightlyRate),
        minimumNights: p.minimumNights,
        maximumNights: p.maximumNights,
      })),
    });
  } catch (e) {
    console.error(e);
  }
});