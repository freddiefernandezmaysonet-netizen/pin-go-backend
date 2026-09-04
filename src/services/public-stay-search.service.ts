import { PrismaClient } from "@prisma/client";
import { fromZonedTime } from "date-fns-tz";
import { checkPropertyAvailability } from "./availability.service";

const prisma = new PrismaClient();

export type PublicStaySearchInput = { destination: string; checkIn: string; checkOut: string; guests: number; };
export type PublicStaySearchResult = {
  organizationSlug: string; propertySlug: string; title: string; city: string | null; region: string | null; country: string | null;
  maxGuests: number | null; minimumNights: number; maximumNights: number | null; photoUrl: string | null; bookingPath: string;
};

export function normalizePublicStaySearchText(value: unknown) { return String(value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim().replace(/\s+/g, " "); }
export function parsePublicStayDateKey(value: unknown) {
  const raw = String(value ?? "").trim(); const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/); if (!match) return null;
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]); const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null; return raw;
}
export function validatePublicStaySearchInput(input: PublicStaySearchInput) {
  const destination = normalizePublicStaySearchText(input.destination); const checkInKey = parsePublicStayDateKey(input.checkIn); const checkOutKey = parsePublicStayDateKey(input.checkOut); const guests = Number(input.guests);
  if (!destination) return { ok: false as const, code: "DESTINATION_REQUIRED" }; if (!checkInKey || !checkOutKey) return { ok: false as const, code: "INVALID_STAY_DATES" };
  if (!Number.isInteger(guests) || guests < 1 || guests > 20) return { ok: false as const, code: "INVALID_GUEST_COUNT" };
  const checkInDate = new Date(`${checkInKey}T00:00:00.000Z`), checkOutDate = new Date(`${checkOutKey}T00:00:00.000Z`), today = new Date();
  const todayKey = `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, "0")}-${String(today.getUTCDate()).padStart(2, "0")}`;
  if (checkInKey < todayKey) return { ok: false as const, code: "CHECK_IN_IN_PAST" }; if (checkOutDate <= checkInDate) return { ok: false as const, code: "CHECK_OUT_MUST_FOLLOW_CHECK_IN" };
  const stayNights = Math.round((checkOutDate.getTime() - checkInDate.getTime()) / 86400000);
  return { ok: true as const, destination, checkInKey, checkOutKey, guests, stayNights };
}
function getPhotoUrl(value: unknown) { return Array.isArray(value) && typeof value[0] === "string" ? value[0] : null; }
function matchesDestination(property: { name: string; publicTitle?: string | null; city?: string | null; region?: string | null; country?: string | null; }, destination: string) {
  const haystack = normalizePublicStaySearchText([property.publicTitle, property.name, property.city, property.region, property.country, [property.city, property.region].filter(Boolean).join(", "), [property.city, property.region, property.country].filter(Boolean).join(", ")].filter(Boolean).join(" "));
  return haystack.includes(destination);
}
function buildPropertyStayDate(dateKey: string, time: string | null | undefined, timezone: string, fallbackTime: string) {
  const safeTime = String(time ?? "").trim() || fallbackTime;
  return fromZonedTime(`${dateKey}T${safeTime}:00`, timezone);
}
function hasValidTimeZone(value: unknown) {
  const timezone = String(value ?? "").trim();
  if (!timezone) return false;
  try { new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date()); return true; } catch { return false; }
}

export async function searchPublicStays(input: PublicStaySearchInput, dependencies: { prismaClient?: PrismaClient; availabilityChecker?: typeof checkPropertyAvailability; } = {}) {
  const validated = validatePublicStaySearchInput(input); if (!validated.ok) return validated;
  const db = dependencies.prismaClient ?? prisma; const availabilityChecker = dependencies.availabilityChecker ?? checkPropertyAvailability;
  const candidates = await db.property.findMany({
    where: { status: "ACTIVE", isPublicBookable: true, slug: { not: null }, maxGuests: { gte: validated.guests }, organization: { publicBookingEnabled: true, slug: { not: null } } },
    select: { id: true, name: true, slug: true, publicTitle: true, publicPhotos: true, maxGuests: true, minimumNights: true, maximumNights: true, city: true, region: true, country: true, timezone: true, checkInTime: true, checkOutTime: true, organization: { select: { slug: true } } }, take: 200,
  });
  const destinationMatches = candidates.filter((property) => matchesDestination(property, validated.destination));
  const stayRuleMatches = destinationMatches.filter((property) => validated.stayNights >= property.minimumNights && (property.maximumNights == null || validated.stayNights <= property.maximumNights));
  const checked = await Promise.all(stayRuleMatches.map(async (property) => {
    const timezone = String(property.timezone ?? "").trim();
    if (!hasValidTimeZone(timezone)) {
      console.warn("[public-stay-search] skipping property with missing/invalid timezone", { propertyId: property.id, propertySlug: property.slug, timezone: timezone || null });
      return null;
    }
    const checkIn = buildPropertyStayDate(validated.checkInKey, property.checkInTime, timezone, "16:00");
    const checkOut = buildPropertyStayDate(validated.checkOutKey, property.checkOutTime, timezone, "11:00");
    const availability = await availabilityChecker({ propertyId: property.id, checkIn, checkOut });
    if (!availability.available || !property.slug || !property.organization.slug) return null;
    const result: PublicStaySearchResult = { organizationSlug: property.organization.slug, propertySlug: property.slug, title: property.publicTitle?.trim() || property.name, city: property.city ?? null, region: property.region ?? null, country: property.country ?? null, maxGuests: property.maxGuests ?? null, minimumNights: property.minimumNights, maximumNights: property.maximumNights ?? null, photoUrl: getPhotoUrl(property.publicPhotos), bookingPath: `/book/${property.organization.slug}/${property.slug}` };
    return result;
  }));
  return { ok: true as const, query: { destination: input.destination.trim(), checkIn: validated.checkInKey, checkOut: validated.checkOutKey, guests: validated.guests, stayNights: validated.stayNights }, results: checked.filter((result): result is PublicStaySearchResult => result !== null) };
}
