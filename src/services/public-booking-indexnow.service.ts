import type { PrismaClient } from "@prisma/client";
import { resolvePublishedBrandContextForOrganization } from "./branding/published-brand-context.service.js";

// Public ownership proof, not a credential for the application or its data.
export const INDEXNOW_KEY = "299dea8ebf3b0f63e33905d6dc422a60";
const ORIGIN = "https://pin-ngo.com";
const ENDPOINT = "https://api.indexnow.org/indexnow";
const validSlug = (s: string | null): s is string => Boolean(s && s.trim() === s && s.length <= 200 && !/[\\/?#\u0000-\u001f\u007f]/.test(s));
export const indexNowEnabled = () => process.env.INDEXNOW_ENABLED === "true" && process.env.NODE_ENV === "production";

export async function capturePublicBookingUrls(db: Pick<PrismaClient, "property">, organizationId: string, propertyId?: string, resolveBrand = resolvePublishedBrandContextForOrganization): Promise<string[]> {
  if (!indexNowEnabled()) return [];
  try {
    const brand = await resolveBrand(organizationId);
    if (brand.kind === "CUSTOM_BRAND") return [];
    const rows = await db.property.findMany({
      where: { organizationId, ...(propertyId ? { id: propertyId } : {}), status: "ACTIVE", isPublicBookable: true,
        isTestProperty: false, slug: { not: null }, organization: { publicBookingEnabled: true, slug: { not: null } } },
      select: { slug: true, organization: { select: { slug: true } } },
    });
    return [...new Set(rows.flatMap(p => validSlug(p.slug) && validSlug(p.organization.slug)
      ? [`${ORIGIN}/book/${encodeURIComponent(p.organization.slug)}`, `${ORIGIN}/book/${encodeURIComponent(p.organization.slug)}/${encodeURIComponent(p.slug)}`] : []))];
  } catch {
    console.warn("[IndexNow] Public URL capture unavailable; sitemap remains the discovery fallback");
    return [];
  }
}

export function publicIndexNowUrls(urls: string[]): string[] {
  return [...new Set(urls)].filter(value => {
    try {
      const u = new URL(value);
      return u.origin === ORIGIN && !u.search && !u.hash && !u.username && !u.password
        && /^\/book\/[^/]+(?:\/[^/]+)?$/.test(u.pathname);
    } catch { return false; }
  });
}

// Bounded best-effort retries. A hint to search engines never changes a saved property.
export async function submitIndexNow(urls: string[], send: typeof fetch = fetch, pause = (ms: number) => new Promise<void>(r => setTimeout(r, ms))): Promise<boolean> {
  const safe = publicIndexNowUrls(urls);
  let accepted = true;
  for (let offset = 0; offset < safe.length; offset += 10000) {
    const urlList = safe.slice(offset, offset + 10000);
    let ok = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await send(ENDPOINT, { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ host: "pin-ngo.com", key: INDEXNOW_KEY, keyLocation: `${ORIGIN}/${INDEXNOW_KEY}.txt`, urlList }),
          signal: AbortSignal.timeout(5000) });
        if (response.status === 200 || response.status === 202) { ok = true; break; }
        if (response.status !== 429 && response.status < 500) break;
      } catch { /* Retry network failures without exposing response bodies or URLs. */ }
      if (attempt < 2) await pause(1000 * 2 ** attempt);
    }
    accepted = accepted && ok;
  }
  return accepted;
}

export async function notifyPublicBookingChange(db: Pick<PrismaClient, "property">, organizationId: string, before: string[], propertyId?: string): Promise<void> {
  if (!indexNowEnabled()) return;
  try {
    const after = await capturePublicBookingUrls(db, organizationId, propertyId);
    const urls = publicIndexNowUrls([...before, ...after]);
    if (!urls.length) return;
    const accepted = await submitIndexNow(urls);
    console.info("[IndexNow]", { accepted, urlCount: urls.length });
  } catch { console.warn("[IndexNow] Notification unavailable; sitemap remains the discovery fallback"); }
}
