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
const BOOKING_ICON_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAALQAAAC0CAYAAAA9zQYyAAAP70lEQVR42u2dd0AU177HvywsoMCCQABFscWoiEgxdg2WS+w9ilHzJLZYotFrj2INaIyRSKLPaPK8tliiiSWaGDsqsSDBBjxExK5Ibwq6vD/eTW6iwp7ZZbbx/fwHe2Z25sxnfvs7Z845Y+HePqAUhJgJClYBodCEUGhCKDQhFJpQaEIoNCEUmhAKTQiFJhSaEApNCIUmRA6sTOlgH5yM5RUzEB4dAk3iOC2MefgoBabgJi80JabcJi80JabcZtMopMzmhaGvp8EiNEVmtDabCE2ZGa3NIkJTZEZrsxG6ImQ2lb5QRlvDXT+9CK1LZVBi85Jb7uspu9DanDwlNm+55by+sgot9WQpcuURW65rraDMxBCNPrk6CGSJ0FIOliJX7mhd0ddfYUp3NTHPaG3UQovenZSZUsuReigoMzEnqRXGepKE6YdBhRa5yygzpZY7Siv0JTMh+vBIYUx3KWHqYRJCU2aiLw90FprpBjGmtENhDnclYZTWew5NiNHn0Ew3iLGlHbJGaKYbRN9eMOUgTDkIMTuhNeU5TDeILn5om0czQhNGaEIoNCEUmhAKTSg0IRSaEApNCIUmhEITCk0IhSaEQhNCoQmh0IRCE0KhCaHQhFBoQig0odCEUGhCKDQhFJoQCk0oNCEUmhAKTQiFJoRCE3PFilWgHRYWFmjp649Wzfzh18gbr3vVgaODCo729rCABQqKipBXmI/b9+/j5r3buH4rDRevXUF80jUUPXlilOdUTeWIwCZN4ftGIzSsWx813NxR3dUNDnZ2sLWxhZWVFQqLilBQVIiCwkLk5Ofh5r07uJ6Wiuu30pCYmoLktFSUlabat9DrF3+Knm911nk/arUaeYUFyM3PQ05eHh5mPMbvidcQn3QNF69dweOsTNnPxVppjVEDQ/Be7wGo41mzzHJOSiWcVCrU8qiBNv7/WQv52fPniE+8hsMxp3A4JhqXk5MMKrGbswsGd+uFru2C4N+4CRSK8n+0Hezs4GBn9+ffAd4+f/s8PSsTp2LPITr2PI78dgoPMx7rN9C4tw/Q6naSsuB5RQmtSfZj52Kwae9u/HrmJJ6r1RX+HS19/fD5jDDU96pdYftsN2wArt+6qXeRG9Sui2mhY9Djrc6wsrSU5Tueq9U4EnMKW/b/iMMx0S9dEzkWzTeblEOhUKBzq7bo3KotUm6n4aOIhTh/Jb7C9t+jQyf894IIKK1Mu8oc7OwQNu4jvNuzLywV8jahLBUKBLftgOC2HXDsXAyGTJvIRqE21K9VG3u+XI/5E6ZUyEVrH9gCaxcuNXmZWzULwIl/7cTw3v1ll/lF7KpUZS+HrhF73OBhWLtwqU4Xr4qtLT6bPle2n2V9EdK9N3auXIMabu5m3Vg3+267nm91xrxxk7Xe/t0efVG7hqdJ18GIvgMROWu+yf/CVKocujzGDhqKg9HHcfZSnORt+3YOFi67/8QRbNyzC8lpN/E4OxMqO3u4VnNG0wYN0cLXD51atEFNj+p6Pfc+nYIRMWUWKguVQmgLCwvMGzcJPceFStpOaWWF5k18hcouWRuFL7ds+Nv/MrKzkJGdhaTUFHx/6AAsLCzQLuBNDO3ZF707/kNjF5muvFGnHlbOCoOFhYVWPRRxCVdw+uIF/BZ/EffSHyEzOwvZebmoYmMLJ5UjnFQqeLq5w7+xDwK8fdCsofffuvQoNIA+E0fi7KXfXz5QS0s4qRzRuN7r6NY+CCHde6OqbRXh/TZv4otmjbwRn3hNeBs3F1chGZ48fYqvd2zVWK60tBTRsecQHXsOKzasw4z3P5DtIYRCocBXcxdLqiPg//vJdx06gC82fYsbd269skzJs3zkFuTj1v27uJSUgIPRx//s1WjZzB+9grqgX+eucFKpmEOXV9GPszIRHXsOcyI/RefQIUhOS5W0j14S+8Id7R2EyhU+KUJxSbGkfSenpWL0/JlIuZ0mS30N79UfTd9oJGmbuw8foNuY4ZgcsaBMmTVF9TNxsZi9chl8+72NSeHzkZiaQqFFSL17G0Omf4jCJ0XC27TyC5D0HVm5uULlnB2dUMujhtHUjVKpxJT/GiVpm7iEqwgePazCnlwWlxRjx8/70XHEYIwKm4nrt1IptCbuPLiPjXt2ScoppfAwIx1ZuTlCZccMetdo6qV/l67wcH1NuPzjrEyEfvxPZGRnVfixlJaWYv/xw5i6bDGFFuHo2TPCZVV29rCvKt7Br1arhfcf2m8QfBs2Noo6CenWS1L58Yvn4sHjdLPoADB5oe8+fCCpvH1Vaa3wr3duFSpnZWmJdQuXGaQh9Fdeq+aMlr7+wuVPXTyPkxfOwlww/QcrEnukpPYqxCdew7DPwuVrV3DE98sXg6lUmmw6mgf2EJSd+Dq7zbCnDB5oWu6eUgqX1BUKPk7wr/+Es+ePxcq29a/OVbPXSJ7H3NZBDZpKqHRm4Nj52IotDHRuXU74bK5BfnIL5Qm9Js+zbArcq2ksRy9OnZB+OQZBqkPnwYNhcuevRRn0MH4cmDSTwpredTAsF79hMsnSewTHTtoKMLGf6TV4KYR/d5BelYGVmxYJ/7zH/YJ+nfpWn5KMXxguf3vXtXFuw/PveIBFoU2EHU9a2HTskhJT8LOxouN5VAoFFg2dTaG9+6v0zFOf/8DpGdmYuNesa5FDxfNXW33Hj0s97jdXcS76249uE+hDXaglpZwdFChcb3X0b1DR8mPvgFg34kjmtuYFhZYOTMMgyV2fZXF0qmzkJGdhZ9OHtVY1t3FtdzPs3Nzy20DVLW1lZS7Zwv2sf/B2gUR6NMpWKf6GBU2E/uPH648Qu/58htZ9ht79bLQOI7ZoydUmMx/RM018z9ByLSJOBNX9pQjWxsbeGkYppp0s/yUqYqNraRjy87LhblRKZYxKC0txZK1URrLdWzRGh8OHSHcoBJ9TGyttMa/wleW22AL9G6qcbzytZTkCq8XCm2CrPv+O8T8Xv6ETKWVFSKmzBIaXbf/xBG8M2U8hk7/ELfu3xU6Bgc7O2xdHlXmZIHWAuNMzl8uf47kk+KnkurF0cGBQpsaB6OPY+FXKzWWe+ftnuUuS/AHiakpmLB4LopLivEoMwMh/5woPAbCzdkF21eshms155fy9oHBPTRufzruQrmfFxYVQS1htns1B0cKbUppxvrvt2F02AyhJQ1CuvcW2u+k8Pl4WvyfoaI37tzCsJmThUf91fGsie+WR/1tTMlbzVtqvJmuJCdpXOPiuVotaR0Mfc+eodBaknr3NvpNGoO5q5YLPeGrpnLEmz6aZ6bEXr2MS0kJL/0/LuEqRoXNFH6a2PSNRtgQ/jmsldZQKBSYMXKc5sby0UNC+74toStO5JxNDbOZgqVWq3Hiwlls3rsbv5w+ISwXAPg18hbKnQ+dOVnmZ0d/O42pyxZh1ZyFQt/ZLuBNfDV3MWLiL760+tCrIq/oeJKr15PQomkzMaGb+kmq47ELZmPsgtmv/EzTojEUugxp84sKkZuXh9yCfDxIf4T4/01AfGICYq9eQrqWS4HV8awlFv3u3yv38x0/74e7iys+Hvuh0P56deyCnkGaZ9EcPHlUeFRh7NXLCO03SKisu4srWvsFamwwM0LrQFlzCuXEyUFsyKdIL0LUlg3wcH0NIweECO1T0y9DaWkpVr0w+bY8Tl44C7VaLfyAZeygd81KaC6nC0ChEBuD6uHqJlRuXtQK7DtWMU/Dfjjyyyvz9rJ4lJmBC1cvC5cPbtPBaCYmUOgKIq+gQKhc+8AWwqnRhCXzyn0yKEJOXi4WrY6UvN22A3sl3MwKrF0QIWkmD4U2cm7euyNUrlPLNvB0Fxt/XVxSjBFzpur0dG/Gigitpkbt+vWApKWF63rWwpqwcNja2FBoc0B0rQ4ba2ssmTRdeOGW3IJ8DJk2EXe0GNW2Zvtm4a66F3laXIwvNn0raZt/tGmPH6PWaRwgRaFNgIcZj4XHZXRrH4R5H0yStO+xC2dLOp6SkhJ8u2u7Tuf0Pz/skDz+269RE0Rv3oVpoWOhsrOn0KbMlv0/CJcdP+Q9rF0QITQhtkvrdli/aJmkY1Eqldj++Vdwc3bR+nyePX+OCUvmSV4AR2Vnj2mhY3Bx10FsCF+BkQNC4N+4Cbyqe8K+alUorazg7OiEejW90NLXDyMHhGDrp6uM5jryHSv/5ruf9mDS0FDh5Wb7dApGx5ZtsHnvbhw6E43ktFTk5ufBwc4eNT2qo41fIAYGd5c0Jeqv1KvphZ0r16DfpDHIzMnWah9XkpMwJ/JTfDZ9ruRt7atWRdd2QejaLsikriOF/kveOWNFODYv+0JSNBs/5D2MH/KeLMfUsG59bP98NQZOHouc/Dyt9rF53w9wreaMWaPGV4rryJTjLxyOOSW5MSU3TRs0xJblq3RaAT9y4zdYtDrSLMc/U2gNLF2/Guu/32ZUx9S8iS82LY3UqVtt9bZNGDlvOnIMPUtF5puKQr9U36WYu2o5pn/2iVZreIigVqux/eA+TF22WHgQVRv/QHy75DOdFrE5cPIYgkYMxq9novVerwk3rmNS+Hz8cvoEhTYEm/buRqfQEJ2f9r3IiQtnETx6GCZHLMDWn37EuEVzhF9B16llG3y9YKlO73u5n/4Iw2d9hP6Tx2j1RgMp5BbkY9uBveg94X10HDEYO37ej5Jnz9goNBRp9+6i/+QxCPD2waiBQ9ArqItW7ym5n/4QO385gO0H9720HvS+Y4dhbaVE1MeLhAYUdWsfhKiPF2HCknmSZqe8yJm4WPSZOAre9RtgSI8+eLttB3hV1/1dMslpqTh18Tx+jTmF6NhzKCkp0es108uLN80FlZ09mvv4orlPMwR4+8DdxRVODio4OahgZWmJnH+/4TYzNxuJN1IQl3AVcQlXkHTzhk7y6YvXver8+WrkujW94OnmjtecXWBrYwNbaxuUPHuGvIJ85BUWIL+gABk52biedhNJN1OQlJqCxBspyC3IN6hDFJoYDDkcYg5NzAoKTSg0IRSaEApNCIUmFJoQCk0IhSaEQhNCoQmFJoRCE0KhCaHQhFBoQqEJodCEUGhCjERoTfO9jOUlMsQ4kWtOKiM0YYQmpFIKzbSD6NsLnYTm2htEDnTxiikHYcrBtIMYqw86C820gxhLuqG3lINRmujLA4U5nQyp3DJXmNBMO4ixeKTQ58EwSjM6yx0UFcZ4coSphlEILXqXUWrKLFfKWuERmlITQ8lskJSDUlNmOdH6HSsVfVLsKal8IstxzWWL0FIPltGaMht1hNZFVEZr804v5Ly+sguta/Sl3OaVI8t9PfUidEWlFJTbtBt6+rh+ehOaeXLlRl/BSK9CU2yKLDeKynCSpHLIbLAIzWhNkc0qQjNaU2azjdCM2JTYrIWm3JTYbIWm4BTYrIUmxOgbhYRQaEIoNKHQhFBoQig0IRSaEApNKDQhFJoQCk0IhSbkT/4PETq6C0YYyq0AAAAASUVORK5CYII=", "base64");
app.get(["/favicon.ico", "/apple-touch-icon.png", "/apple-touch-icon-precomposed.png"], (_q, res) => {
  res.set("Cache-Control", "public, max-age=86400, immutable");
  res.type("png").send(BOOKING_ICON_PNG);
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