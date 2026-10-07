import { Prisma, type PrismaClient } from "@prisma/client";
export type CleanerTaskView = "today" | "upcoming" | "history";

/** Filter in property local time before pagination, scoped to the authenticated cleaner. */
export async function cleanerTaskPageIds(db: PrismaClient, input: {
  staffMemberId: string; organizationId: string; view: CleanerTaskView;
  cursor?: string; now: Date; limit: number;
}): Promise<string[]> {
  const rows = await db.$queryRaw<{ id: string }[]>(Prisma.sql`
    WITH tasks AS (
      SELECT c.id,
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
        ${input.cursor ? Prisma.sql`AND c.id < ${input.cursor}` : Prisma.empty}
    )
    SELECT id FROM tasks WHERE
      (${input.view} = 'today' AND (day = today OR (day < today AND NOT closed))) OR
      (${input.view} = 'upcoming' AND day > today AND NOT closed) OR
      (${input.view} = 'history' AND closed)
    ORDER BY id DESC LIMIT ${input.limit}
  `);
  return rows.map(row => row.id);
}
