import type { PrismaClient } from "@prisma/client";

const APP_HOST = "app.pin-ngo.com";
const MAX_URLS = 50_000;
const BATCH_SIZE = 500;
type Brand = { kind: string; customDomain: string | null };

function validSlug(value: string | null): value is string {
  return Boolean(value && value.trim() === value && value.length <= 200 && !/[\\/?#\u0000-\u001f\u007f]/.test(value));
}
function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

// Public read-only discovery. Never infer test status from a name or a price.
export async function buildPublicStaysSitemap(
  db: Pick<PrismaClient, "property">,
  resolveBrand: (organizationId: string) => Promise<Brand>,
): Promise<string> {
  const urls = new Set<string>();
  const brands = new Map<string, Brand>();
  let cursor: string | undefined;
  while (true) {
    const properties = await db.property.findMany({
      where: {
        status: "ACTIVE", isPublicBookable: true, isTestProperty: false,
        slug: { not: null },
        organization: { publicBookingEnabled: true, slug: { not: null } },
      },
      select: { id: true, slug: true, organization: { select: { id: true, slug: true } } },
      orderBy: { id: "asc" }, take: BATCH_SIZE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    for (const property of properties) {
      const organization = property.organization;
      if (!validSlug(property.slug) || !validSlug(organization.slug)) continue;
      let brand = brands.get(organization.id);
      if (!brand) {
        brand = await resolveBrand(organization.id);
        brands.set(organization.id, brand);
      }
      // Custom-domain canonicals have their own existing sitemap.
      if (brand.kind === "CUSTOM_BRAND" && brand.customDomain !== APP_HOST) continue;
      urls.add(`https://${APP_HOST}/book/${encodeURIComponent(organization.slug)}/${encodeURIComponent(property.slug)}`);
      if (urls.size > MAX_URLS) throw new Error("SITEMAP_INDEX_REQUIRED");
    }
    if (properties.length < BATCH_SIZE) break;
    cursor = properties[properties.length - 1]!.id;
  }
  const xml = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
    + [...urls].sort().map(url => `  <url><loc>${escapeXml(url)}</loc></url>`).join("\n")
    + '\n</urlset>\n';
  if (Buffer.byteLength(xml, "utf8") > 50 * 1024 * 1024) throw new Error("SITEMAP_INDEX_REQUIRED");
  return xml;
}
