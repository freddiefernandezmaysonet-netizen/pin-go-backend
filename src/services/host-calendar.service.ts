import type { PrismaClient } from "@prisma/client";
import { formatInTimeZone } from "date-fns-tz";

export type CalendarQuery = {
  from: string;
  to: string;
  page: number;
  propertyId?: string;
};
export type CalendarPricing = (input: {
  propertyId: string;
  checkIn: Date;
  checkOut: Date;
  includeAuditEntries: false;
}) => Promise<{ nightlyRates: { date: string; rate: number }[] }>;
const DAY = 86_400_000;
export const CALENDAR_PAGE_SIZE = 10;

export function parseCalendarQuery(
  raw: Record<string, unknown>,
): CalendarQuery {
  const valid = (v: unknown): v is string =>
    typeof v === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(v) &&
    Number.isFinite(Date.parse(v)) &&
    new Date(v).toISOString().slice(0, 10) === v;
  if (!valid(raw.from) || !valid(raw.to))
    throw new Error("CALENDAR_RANGE_INVALID");
  const days = (Date.parse(raw.to) - Date.parse(raw.from)) / DAY;
  if (days < 1 || days > 31) throw new Error("CALENDAR_RANGE_INVALID");
  const page = raw.page === undefined ? 1 : Number(raw.page);
  if (!Number.isSafeInteger(page) || page < 1 || page > 10000)
    throw new Error("CALENDAR_PAGE_INVALID");
  if (
    raw.propertyId !== undefined &&
    (typeof raw.propertyId !== "string" ||
      !raw.propertyId.trim() ||
      raw.propertyId.length > 128)
  )
    throw new Error("CALENDAR_PROPERTY_INVALID");
  return {
    from: raw.from,
    to: raw.to,
    page,
    ...(typeof raw.propertyId === "string"
      ? { propertyId: raw.propertyId }
      : {}),
  };
}

function photo(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const first = value[0];
  const url = typeof first === "string" ? first : first?.url;
  return typeof url === "string" && /^https:\/\//.test(url) ? url : null;
}

export async function getHostCalendar(
  db: Pick<
    PrismaClient,
    | "property"
    | "reservation"
    | "propertyBlockedDate"
    | "propertyNightlyRestriction"
  >,
  pricing: CalendarPricing,
  organizationId: string,
  query: CalendarQuery,
  now = new Date(),
) {
  if (!organizationId) throw new Error("CALENDAR_UNAUTHENTICATED");
  const where = {
    organizationId,
    status: "ACTIVE",
    ...(query.propertyId ? { id: query.propertyId } : {}),
  };
  const [total, properties] = await Promise.all([
    db.property.count({ where }),
    db.property.findMany({
      where,
      orderBy: { id: "asc" },
      skip: (query.page - 1) * CALENDAR_PAGE_SIZE,
      take: CALENDAR_PAGE_SIZE,
      select: {
        id: true,
        name: true,
        timezone: true,
        publicPhotos: true,
        minimumNights: true,
        maximumNights: true,
      },
    }),
  ]);
  if (query.propertyId && total === 0)
    throw new Error("CALENDAR_PROPERTY_NOT_FOUND");
  const from = new Date(query.from),
    to = new Date(query.to);
  const dates = Array.from(
    { length: (to.getTime() - from.getTime()) / DAY },
    (_, i) => new Date(from.getTime() + i * DAY).toISOString().slice(0, 10),
  );
  const items = [];
  // Bound database and pricing work to two properties at a time.
  for (let offset = 0; offset < properties.length; offset += 2) {
    const batch = await Promise.all(
      properties.slice(offset, offset + 2).map(async (property) => {
        const timezone = property.timezone || "America/Puerto_Rico";
        const base = {
          id: property.id,
          name: property.name,
          photoUrl: photo(property.publicPhotos),
          timezone,
        };
        try {
          const [reservations, blocks, restrictions, rates] = await Promise.all(
            [
              db.reservation.findMany({
                where: {
                  property: { organizationId },
                  propertyId: property.id,
                  status: "ACTIVE",
                  checkIn: { lt: new Date(to.getTime() + DAY) },
                  checkOut: { gt: new Date(from.getTime() - DAY) },
                },
                select: {
                  id: true,
                  reservationNumber: true,
                  guestName: true,
                  checkIn: true,
                  checkOut: true,
                },
              }),
              db.propertyBlockedDate.findMany({
                where: {
                  propertyId: property.id,
                  property: { organizationId },
                  startDate: { lt: to },
                  endDate: { gt: from },
                },
                select: {
                  id: true,
                  startDate: true,
                  endDate: true,
                  reason: true,
                },
              }),
              db.propertyNightlyRestriction.findMany({
                where: { propertyId: property.id, date: { gte: from, lt: to } },
                select: {
                  date: true,
                  minimumNights: true,
                  maximumNights: true,
                },
              }),
              pricing({
                propertyId: property.id,
                checkIn: from,
                checkOut: to,
                includeAuditEntries: false,
              }).catch(() => null),
            ],
          );
          const stays = reservations
            .map((r) => ({
              id: r.id,
              number: r.reservationNumber,
              guestName: r.guestName,
              from: formatInTimeZone(r.checkIn, timezone, "yyyy-MM-dd"),
              to: formatInTimeZone(r.checkOut, timezone, "yyyy-MM-dd"),
            }))
            .filter((r) => r.from < query.to && r.to > query.from);
          const blocked = blocks.map((b) => ({
            id: b.id,
            from: b.startDate.toISOString().slice(0, 10),
            to: b.endDate.toISOString().slice(0, 10),
            reason: b.reason,
          }));
          const rateMap = new Map(
            rates?.nightlyRates.map((r) => [
              String(r.date).slice(0, 10),
              Number(r.rate),
            ]),
          );
          const restrictionMap = new Map(
            restrictions.map((r) => [r.date.toISOString().slice(0, 10), r]),
          );
          return {
            ...base,
            state: "READY" as const,
            today: formatInTimeZone(now, timezone, "yyyy-MM-dd"),
            reservations: stays,
            blocks: blocked,
            days: dates.map((date) => {
              const rule = restrictionMap.get(date),
                rate = rateMap.get(date);
              return {
                date,
                rate: rate !== undefined && Number.isFinite(rate) ? rate : null,
                minimumNights: rule?.minimumNights ?? property.minimumNights,
                maximumNights: rule?.maximumNights ?? property.maximumNights,
                status: stays.some((s) => s.from <= date && date < s.to)
                  ? ("BOOKED" as const)
                  : blocked.some((b) => b.from <= date && date < b.to)
                    ? ("BLOCKED" as const)
                    : ("OPEN" as const),
              };
            }),
            pricingUnavailable: rates === null,
          };
        } catch {
          // A failed occupancy read must never look like an available property.
          return {
            ...base,
            state: "UNAVAILABLE" as const,
            today: null,
            reservations: [],
            blocks: [],
            days: [],
            pricingUnavailable: true,
          };
        }
      }),
    );
    items.push(...batch);
  }
  return {
    from: query.from,
    to: query.to,
    page: query.page,
    pageSize: CALENDAR_PAGE_SIZE,
    total,
    hasMore: query.page * CALENDAR_PAGE_SIZE < total,
    items,
  };
}
