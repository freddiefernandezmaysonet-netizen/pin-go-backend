import { Prisma, type PrismaClient } from "@prisma/client";
export type CleanerTaskFilters = { q?: string; status?: string; from?: string; to?: string };
const STATUSES = new Set(["PENDING", "CONFIRMED", "IN_PROGRESS", "COMPLETED", "CANCELLED", "REASSIGNED", "EXPIRED", "DECLINED"]);
export function parseCleanerTaskFilters(query: Record<string, unknown>): CleanerTaskFilters {
  const filters: CleanerTaskFilters = {};
  for (const key of ["q", "status", "from", "to"] as const) {
    const value = query[key];
    if (value === undefined || value === "") continue;
    if (typeof value !== "string") throw new Error("CLEANING_FILTER_INVALID");
    const trimmed = value.trim();
    if (trimmed) filters[key] = trimmed;
  }
  if ((filters.q?.length ?? 0) > 100 || (filters.status && !STATUSES.has(filters.status))) throw new Error("CLEANING_FILTER_INVALID");
  for (const value of [filters.from, filters.to]) {
    if (value && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.slice(0, 4) === "0000" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value)) throw new Error("CLEANING_FILTER_INVALID");
  }
  if (filters.from && filters.to && filters.from > filters.to) throw new Error("CLEANING_FILTER_INVALID");
  return filters;
}
export type CleanerTaskView = "today" | "upcoming" | "history";

/** Filter in property local time before pagination, scoped to the authenticated cleaner. */
export async function cleanerTaskPageIds(db: PrismaClient, input: {
  staffMemberId: string; organizationId: string; view: CleanerTaskView;
  cursor?: string; now: Date; limit: number; filters?: CleanerTaskFilters;
}): Promise<string[]> {
  const rows = await db.$queryRaw<{ id: string }[]>(Prisma.sql`
    WITH tasks AS (
      SELECT c.id,
        CASE WHEN r.status::text = 'CANCELLED' THEN 'CANCELLED'
          WHEN w."completionConfirmedAt" IS NOT NULL THEN 'COMPLETED'
          WHEN w."cancelledAt" IS NOT NULL THEN 'CANCELLED'
          WHEN w."supersededAt" IS NOT NULL THEN 'REASSIGNED'
          WHEN w."startConfirmedAt" IS NOT NULL THEN 'IN_PROGRESS'
          ELSE c.status END AS status,
        (COALESCE(w."scheduledStartAt", r."checkOut") AT TIME ZONE 'UTC' AT TIME ZONE p.timezone)::date AS day,
        (${input.now}::timestamptz AT TIME ZONE p.timezone)::date AS today,
        (r.status::text = 'CANCELLED' OR w."completionConfirmedAt" IS NOT NULL
          OR w."cancelledAt" IS NOT NULL OR w."supersededAt" IS NOT NULL
          OR c.status IN ('COMPLETED', 'CANCELLED', 'REASSIGNED', 'EXPIRED', 'DECLINED')) AS closed
      FROM "CleaningConfirmation" c
      JOIN "Reservation" r ON r.id = c."reservationId" AND r."propertyId" = c."propertyId"
      JOIN "Property" p ON p.id = c."propertyId"
      LEFT JOIN "CleaningWork" w ON w."confirmationId" = c.id AND w."staffMemberId" = c."staffMemberId"
        AND w."reservationId" = r.id AND w."propertyId" = p.id
      WHERE c."staffMemberId" = ${input.staffMemberId} AND p."organizationId" = ${input.organizationId}
        ${input.filters?.q ? Prisma.sql`AND strpos(lower(p.name), lower(${input.filters.q})) > 0` : Prisma.empty}
        ${input.cursor ? Prisma.sql`AND c.id < ${input.cursor}` : Prisma.empty}
    )
    SELECT id FROM tasks WHERE (
      (${input.view} = 'today' AND (day = today OR (day < today AND NOT closed))) OR
      (${input.view} = 'upcoming' AND day > today AND NOT closed) OR
      (${input.view} = 'history' AND closed))
      ${input.filters?.status ? Prisma.sql`AND status = ${input.filters.status}` : Prisma.empty}
      ${input.filters?.from ? Prisma.sql`AND day >= ${input.filters.from}::date` : Prisma.empty}
      ${input.filters?.to ? Prisma.sql`AND day <= ${input.filters.to}::date` : Prisma.empty}
    ORDER BY id DESC LIMIT ${input.limit}
  `);
  return rows.map(row => row.id);
}
