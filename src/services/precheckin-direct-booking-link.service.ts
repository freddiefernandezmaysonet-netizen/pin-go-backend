import type { PrismaClient } from "@prisma/client";

// Read current eligibility on every delivery, including retries. Never promote OTA stays.
export async function resolvePrecheckinDirectBookingUrl(
  prisma: PrismaClient, reservationId: string,
): Promise<string | null> {
  try {
    const reservation = await prisma.reservation.findUnique({
      where: { id: reservationId },
      select: {
        preferredLanguage: true, source: true, externalProvider: true, externalId: true,
        property: { select: {
          status: true, isPublicBookable: true, isTestProperty: true, slug: true,
          organization: { select: { publicBookingEnabled: true, slug: true } },
        } },
      },
    });
    if (!reservation || !["DIRECT_BOOKING", "MANUAL"].includes(reservation.source ?? "")
      || reservation.externalProvider || reservation.externalId) return null;
    const property = reservation.property;
    const organization = property?.organization;
    if (property?.status !== "ACTIVE" || !property.isPublicBookable || property.isTestProperty
      || !organization?.publicBookingEnabled || !property.slug || !organization.slug) return null;
    const url = new URL(`/book/${encodeURIComponent(organization.slug)}/${encodeURIComponent(property.slug)}`, "https://pin-ngo.com");
    url.searchParams.set("lang", reservation.preferredLanguage === "es" ? "es" : "en");
    url.searchParams.set("utm_source", "pingo");
    url.searchParams.set("utm_medium", "email");
    url.searchParams.set("utm_campaign", "precheckin_return_stay");
    return url.toString();
  } catch {
    // An optional promotion must never prevent arrival instructions from being sent.
    return null;
  }
}
