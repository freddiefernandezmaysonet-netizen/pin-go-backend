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
const STAGING_REVISION = "booking-search-staging-v10-review-audit";
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
    organizationSlug: p.organization.slug, propertySlug: p.slug,
    title: p.publicTitle?.trim() || p.name, city: p.city ?? null, region: p.region ?? null,
    country: p.country ?? null, maxGuests: p.maxGuests ?? null, minimumNights: p.minimumNights,
    maximumNights: p.maximumNights ?? null,
    baseNightlyRate: p.baseNightlyRate == null ? null : Number(p.baseNightlyRate),
    photoUrl: Array.isArray(p.publicPhotos) && typeof p.publicPhotos[0] === "string" ? p.publicPhotos[0] : null,
    bookingPath: p.organization.slug && p.slug ? `/book/${p.organization.slug}/${p.slug}` : null,
  };
}

app.get("/", (_q, res) => {
  const file = path.resolve(process.cwd(), "src/booking-search.preview.html");
  let html = fs.readFileSync(file, "utf8");
  const enhancement = `<style>.reviewrating{margin:7px 0 10px;color:#173d32;font-size:14px;font-weight:800}.reviewrating span{color:#66736e;font-weight:600}</style><script>(function(){function decorate(){try{if(typeof featured==='undefined'||!Array.isArray(featured))return;var cards=document.querySelectorAll('#featuredCards .card');cards.forEach(function(card,i){var p=featured[i];if(!p||!(Number(p.reviewCount)>0)||!Number.isFinite(Number(p.averageRating)))return;var body=card.querySelector('.body');if(!body)return;var old=body.querySelector('.reviewrating');if(old)old.remove();var rating=Number(p.averageRating).toFixed(1);var count=Number(p.reviewCount);var label=(document.documentElement.lang==='en'?(count===1?'review':'reviews'):(count===1?'reseña':'reseñas'));var el=document.createElement('div');el.className='reviewrating';el.innerHTML='★ '+rating+' <span>· '+count+' '+label+'</span>';var h3=body.querySelector('h3');if(h3)h3.insertAdjacentElement('afterend',el);}}catch(e){}}var target=document.getElementById('featuredCards');if(target)new MutationObserver(function(){decorate()}).observe(target,{childList:true,subtree:true});document.getElementById('esBtn')?.addEventListener('click',function(){setTimeout(decorate,0)});document.getElementById('enBtn')?.addEventListener('click',function(){setTimeout(decorate,0)});setTimeout(decorate,500);})();</script>`;
  html = html.replace("</body>", enhancement + "</body>");
  res.type("html").send(html);
});
app.get("/health", (_q, r) => r.json({ ok: true, service: "pin-go-booking-search-staging", revision: STAGING_REVISION }));
app.get("/ready", async (_q, r) => { try { await prisma.$queryRaw`SELECT 1`; r.json({ ok: true, service: "pin-go-booking-search-staging", revision: STAGING_REVISION }); } catch { r.status(500).json({ ok: false }); } });

app.get("/api/public-booking/catalog", async (_q, res) => {
  try {
    const items = await prisma.property.findMany({ where: publicPropertyWhere, select: publicPropertySelect(), orderBy: { createdAt: "asc" }, take: 200 });
    return res.json({ ok: true, revision: STAGING_REVISION, results: items.map(publicPropertyPayload) });
  } catch (e) { console.error(e); return res.status(500).json({ ok: false, error: "PUBLIC_STAY_CATALOG_FAILED" }); }
});

app.get("/api/public-booking/featured-audit", async (_q, res) => {
  try {
    const now = new Date();
    const since = new Date(now.getTime() - 365 * 86_400_000);
    const items = await prisma.property.findMany({ where: publicPropertyWhere, select: publicPropertySelect(), orderBy: { createdAt: "asc" }, take: 200 });
    const ranked = await Promise.all(items.map(async (p: any) => {
      let reviewCount = 0;
      let averageRating: number | null = null;
      try {
        const [count, aggregate] = await Promise.all([
          prisma.propertyReview.count({ where: { propertyId: p.id, status: "PUBLISHED", source: "PIN_GO_DIRECT" } }),
          prisma.propertyReview.aggregate({ where: { propertyId: p.id, status: "PUBLISHED", source: "PIN_GO_DIRECT" }, _avg: { overallRating: true } }),
        ]);
        reviewCount = count;
        averageRating = aggregate._avg.overallRating == null ? null : Number(aggregate._avg.overallRating);
      } catch (reviewError) {
        console.warn("[booking-featured-audit] review metrics unavailable", { propertyId: p.id, error: reviewError instanceof Error ? reviewError.message : String(reviewError) });
      }
      const completedStays365 = await prisma.reservation.count({ where: { propertyId: p.id, status: "ACTIVE", checkOut: { gte: since, lt: now } } });
      const guestFavorite = reviewCount >= 3 && averageRating != null && averageRating >= 4.8;
      const reviewScore = guestFavorite ? 100 + averageRating * 10 + Math.min(reviewCount, 20) : 0;
      const popularityScore = Math.min(completedStays365, 50) * 5;
      const readinessScore = (p.publicTitle?.trim() ? 2 : 0) + (Array.isArray(p.publicPhotos) && typeof p.publicPhotos[0] === "string" ? 2 : 0) + (p.baseNightlyRate != null && Number(p.baseNightlyRate) > 0 ? 1 : 0) + (p.city ? 1 : 0);
      const score = reviewScore + popularityScore + readinessScore;
      const reason = guestFavorite ? "GUEST_FAVORITE" : completedStays365 > 0 ? "POPULAR" : "PIN_GO_PICK";
      return { ...publicPropertyPayload(p), reviewCount, averageRating, completedStays365, featuredReason: reason, featuredScore: score };
    }));
    ranked.sort((a, b) => b.featuredScore - a.featuredScore || b.completedStays365 - a.completedStays365 || (b.averageRating ?? 0) - (a.averageRating ?? 0) || a.title.localeCompare(b.title));
    return res.json({ ok: true, revision: STAGING_REVISION, windowDays: 365, guestFavoriteRule: { minimumPublishedReviews: 3, minimumAverageRating: 4.8 }, results: ranked.slice(0, 6) });
  } catch (e) { console.error("[booking-featured-audit] failed", e); return res.status(500).json({ ok: false, error: "PUBLIC_FEATURED_AUDIT_FAILED" }); }
});

app.get("/api/public-booking/search", async (req, res) => {
  try {
    const result = await searchPublicStays({ destination: String(req.query.destination ?? ""), checkIn: String(req.query.checkIn ?? ""), checkOut: String(req.query.checkOut ?? ""), guests: Number(req.query.guests) });
    if (!result.ok) return res.status(400).json({ ok: false, error: result.code });
    const slugs = result.results.map(p => p.propertySlug);
    const rates = slugs.length ? await prisma.property.findMany({ where: { slug: { in: slugs } }, select: { slug: true, baseNightlyRate: true } }) : [];
    const m = new Map(rates.map(p => [p.slug, p.baseNightlyRate == null ? null : Number(p.baseNightlyRate)]));
    return res.json({ ...result, results: result.results.map(p => ({ ...p, baseNightlyRate: m.get(p.propertySlug) ?? null })), revision: STAGING_REVISION });
  } catch (e) { console.error(e); return res.status(500).json({ ok: false, error: "PUBLIC_STAY_SEARCH_FAILED" }); }
});

app.listen(PORT, async () => {
  console.log(`[booking-search-staging] listening on ${PORT} revision=${STAGING_REVISION}`);
  try {
    const x = await prisma.property.findMany({ where: publicPropertyWhere, select: { id: true, slug: true, publicTitle: true, name: true, city: true, region: true, timezone: true, baseNightlyRate: true, minimumNights: true, maximumNights: true, organization: { select: { slug: true } } }, take: 200 });
    console.log("[booking-search-staging] eligible-public-catalog", { count: x.length, properties: x.map(p => ({ organizationSlug: p.organization.slug, propertySlug: p.slug, title: p.publicTitle?.trim() || p.name, city: p.city, region: p.region, baseNightlyRate: p.baseNightlyRate == null ? null : Number(p.baseNightlyRate), minimumNights: p.minimumNights, maximumNights: p.maximumNights })) });

    const demo = x.find(p => (p.publicTitle?.trim() || p.name) === "Pin&Go Demo Property");
    if (demo) {
      const reviews = await prisma.propertyReview.findMany({
        where: { propertyId: demo.id },
        select: { id: true, status: true, source: true, overallRating: true, propertyId: true, reservationId: true, submittedAt: true, publishedAt: true },
        orderBy: { submittedAt: "asc" },
      });
      const publicReviews = reviews.filter(r => r.status === "PUBLISHED" && r.source === "PIN_GO_DIRECT");
      const publicAverage = publicReviews.length ? publicReviews.reduce((sum, r) => sum + r.overallRating, 0) / publicReviews.length : null;
      console.log("[booking-review-audit] pin-go-demo-property", {
        propertyId: demo.id,
        propertySlug: demo.slug,
        totalReviews: reviews.length,
        publishedCount: reviews.filter(r => r.status === "PUBLISHED").length,
        publicReviewCount: publicReviews.length,
        publicAverageRating: publicAverage,
        reviews: reviews.map(r => ({ id: r.id, status: r.status, source: r.source, overallRating: r.overallRating, propertyId: r.propertyId, reservationId: r.reservationId, submittedAt: r.submittedAt.toISOString(), publishedAt: r.publishedAt?.toISOString() ?? null })),
      });
    }
  } catch (e) { console.error(e); }
});