import { Prisma, type PrismaClient } from "@prisma/client";

export const hostCleaningStatuses = ["PENDING", "CONFIRMED", "IN_PROGRESS", "COMPLETED", "CANCELLED", "DECLINED", "REASSIGNED", "EXPIRED"] as const;
export function parseHostCleaningFilters(query: Record<string, unknown>) {
  const read = (key: string) => {
    const value = query[key];
    if (value === undefined || value === "") return undefined;
    if (typeof value !== "string" || value.length > 200) throw new Error("INVALID_FILTER");
    return value;
  };
  const view = read("view") ?? "today";
  const status = read("status");
  if (!["today", "upcoming", "history", "all"].includes(view) || status && !hostCleaningStatuses.includes(status as typeof hostCleaningStatuses[number])) throw new Error("INVALID_FILTER");
  return { view, status, propertyId: read("propertyId"), staffMemberId: read("staffMemberId"), reservationId: read("reservationId"), cursor: read("cursor") };
}
export type HostCleaningFilters = ReturnType<typeof parseHostCleaningFilters>;
export async function listHostCleanings(db: PrismaClient, organizationId: string, filters: HostCleaningFilters, now = new Date()) {
  const state = Prisma.sql`CASE WHEN r.status = 'CANCELLED' THEN 'CANCELLED' WHEN w."completionConfirmedAt" IS NOT NULL THEN 'COMPLETED' WHEN w."cancelledAt" IS NOT NULL THEN 'CANCELLED' WHEN w."supersededAt" IS NOT NULL THEN 'REASSIGNED' WHEN w."startConfirmedAt" IS NOT NULL THEN 'IN_PROGRESS' ELSE c.status END`;
  const start = Prisma.sql`COALESCE(w."scheduledStartAt", r."checkOut" + p."cleaningStartOffsetMinutes" * interval '1 minute')`;
  const localDay = Prisma.sql`(${start} AT TIME ZONE 'UTC' AT TIME ZONE COALESCE(p.timezone, 'UTC'))::date`;
  const today = Prisma.sql`(${now}::timestamptz AT TIME ZONE COALESCE(p.timezone, 'UTC'))::date`;
  const terminal = Prisma.sql`${state} IN ('COMPLETED', 'CANCELLED', 'DECLINED', 'REASSIGNED', 'EXPIRED')`;
  const clauses = [Prisma.sql`p."organizationId" = ${organizationId}`];
  if (filters.propertyId) clauses.push(Prisma.sql`p.id = ${filters.propertyId}`);
  if (filters.staffMemberId) clauses.push(Prisma.sql`c."staffMemberId" = ${filters.staffMemberId}`);
  if (filters.reservationId) clauses.push(Prisma.sql`r.id = ${filters.reservationId}`);
  if (filters.status) clauses.push(Prisma.sql`${state} = ${filters.status}`);
  if (filters.cursor) clauses.push(Prisma.sql`c.id < ${filters.cursor}`);
  if (filters.view === "today") clauses.push(Prisma.sql`${localDay} = ${today}`);
  if (filters.view === "upcoming") clauses.push(Prisma.sql`${localDay} > ${today} AND NOT (${terminal})`);
  if (filters.view === "history") clauses.push(terminal);
  const ids = await db.$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT c.id FROM "CleaningConfirmation" c
    JOIN "Reservation" r ON r.id = c."reservationId" AND r."propertyId" = c."propertyId"
    JOIN "Property" p ON p.id = r."propertyId"
    JOIN "StaffMember" s ON s.id = c."staffMemberId" AND s."organizationId" = p."organizationId"
    LEFT JOIN "CleaningWork" w ON w."confirmationId" = c.id AND w."reservationId" = r.id AND w."propertyId" = p.id AND w."staffMemberId" = s.id
    WHERE ${Prisma.join(clauses, " AND ")} ORDER BY c.id DESC LIMIT 51`);
  const pageIds = ids.slice(0, 50).map(row => row.id);
  const properties = await db.property.findMany({ where: { organizationId }, select: { id: true, name: true, timezone: true, cleaningStartOffsetMinutes: true } });
  const propertyIds = properties.map(p => p.id);
  const offers = await db.cleaningConfirmation.findMany({ where: { id: { in: pageIds }, propertyId: { in: propertyIds } }, select: { id: true, reservationId: true, propertyId: true, staffMemberId: true, status: true } });
  const reservationIds = offers.map(o => o.reservationId);
  const [reservations, staff, works, checklists] = await Promise.all([
    db.reservation.findMany({ where: { id: { in: reservationIds }, propertyId: { in: propertyIds } }, select: { id: true, reservationNumber: true, status: true, checkOut: true, propertyId: true } }),
    db.staffMember.findMany({ where: { organizationId }, select: { id: true, fullName: true } }),
    db.cleaningWork.findMany({ where: { confirmationId: { in: pageIds }, propertyId: { in: propertyIds } }, include: { issueReports: { orderBy: { reportedAt: "desc" }, select: { id: true, kind: true, reason: true, estimatedAt: true, reportedAt: true } } } }),
    db.cleaningTaskChecklist.findMany({ where: { reservationId: { in: reservationIds }, propertyId: { in: propertyIds } }, include: { items: { orderBy: { position: "asc" }, select: { id: true, labelEs: true, labelEn: true, required: true, checked: true, checkedAt: true } } } }),
  ]);
  const items = pageIds.flatMap(id => {
    const offer = offers.find(o => o.id === id);
    if (!offer) return [];
    const reservation = reservations.find(r => r.id === offer.reservationId && r.propertyId === offer.propertyId);
    const property = properties.find(p => p.id === offer.propertyId);
    const cleaner = staff.find(s => s.id === offer.staffMemberId);
    if (!reservation || !property || !cleaner) return [];
    const work = works.find(w => w.confirmationId === id && w.reservationId === reservation.id && w.staffMemberId === cleaner.id);
    const status = reservation.status === "CANCELLED" ? "CANCELLED" : work?.completionConfirmedAt ? "COMPLETED" : work?.cancelledAt ? "CANCELLED" : work?.supersededAt ? "REASSIGNED" : work?.startConfirmedAt ? "IN_PROGRESS" : offer.status;
    const scheduledStartAt = work?.scheduledStartAt ?? new Date(reservation.checkOut.getTime() + property.cleaningStartOffsetMinutes * 60_000);
    return [{ id, property: { id: property.id, name: property.name, timezone: property.timezone ?? "UTC" }, cleaner, reservation: { id: reservation.id, number: reservation.reservationNumber }, status,
      scheduledStartAt, committedEndAt: work ? new Date(work.scheduledStartAt.getTime() + work.durationCommitmentMinutes * 60_000) : null,
      startedAt: work?.startConfirmedAt ?? null, completedAt: work?.completionConfirmedAt ?? null,
      actualDurationMinutes: work?.startConfirmedAt && work.completionConfirmedAt ? Math.max(0, Math.round((work.completionConfirmedAt.getTime() - work.startConfirmedAt.getTime()) / 60_000)) : null,
      checklist: checklists.find(c => c.reservationId === reservation.id)?.items ?? null, reports: work?.issueReports ?? [] }];
  });
  return { items, nextCursor: ids.length > 50 ? pageIds[pageIds.length - 1] : null, properties: properties.map(({ id, name }) => ({ id, name })), staff };
}
