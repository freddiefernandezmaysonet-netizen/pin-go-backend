import {
  PrismaClient,
  ReservationStatus,
  AccessGrantType,
} from "@prisma/client";
import { Router } from "express";
import { requireAuth } from "../middleware/requireAuth";

const prisma = new PrismaClient();
export const dashboardReservationsRouter = Router();

function getOperationalStatus(r: {
  status: ReservationStatus;
  checkIn: Date;
  checkOut: Date;
}) {
  const now = new Date();

  if (r.status === ReservationStatus.CANCELLED) return "CANCELLED";
  if (now < r.checkIn) return "UPCOMING";
  if (now >= r.checkIn && now < r.checkOut) return "IN_HOUSE";
  return "CHECKED_OUT";
}

function toInt(v: any, def: number) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

dashboardReservationsRouter.get("/api/dashboard/reservations", requireAuth, async (req, res) => {
  const user = (req as any).user;
  const orgId = user.orgId as string;

  const propertyId =
    typeof req.query.propertyId === "string" ? req.query.propertyId : undefined;
  const statusQ =
    typeof req.query.status === "string" ? req.query.status : undefined;
  const fromQ = typeof req.query.from === "string" ? req.query.from : undefined;
  const toQ = typeof req.query.to === "string" ? req.query.to : undefined;
  const search =
    typeof req.query.search === "string" ? req.query.search.trim() : "";

  const page = clamp(toInt(req.query.page, 1), 1, 10_000);
  const pageSize = clamp(toInt(req.query.pageSize, 25), 1, 100);
  const sort =
    typeof req.query.sort === "string" ? req.query.sort : "checkIn_desc";

  const status =
    statusQ === "ACTIVE"
      ? ReservationStatus.ACTIVE
      : statusQ === "CANCELLED"
      ? ReservationStatus.CANCELLED
      : undefined;

  const from = fromQ ? new Date(fromQ) : undefined;
  const to = toQ ? new Date(toQ) : undefined;

  const orderBy =
    sort === "checkIn_asc"
      ? { checkIn: "asc" as const }
      : sort === "checkIn_desc"
      ? { checkIn: "desc" as const }
      : sort === "checkOut_asc"
      ? { checkOut: "asc" as const }
      : sort === "checkOut_desc"
      ? { checkOut: "desc" as const }
      : sort === "updatedAt_desc"
      ? { updatedAt: "desc" as const }
      : { checkIn: "desc" as const };

  const where: any = {
    property: { organizationId: orgId },
  };

  if (propertyId) where.propertyId = propertyId;
  if (status) where.status = status;

  if (from || to) {
    where.AND = [];
    if (to) where.AND.push({ checkIn: { lt: to } });
    if (from) where.AND.push({ checkOut: { gt: from } });
  }

  if (search) {
    where.OR = [
      { guestName: { contains: search, mode: "insensitive" } },
      { guestEmail: { contains: search, mode: "insensitive" } },
      { roomName: { contains: search, mode: "insensitive" } },
      { externalId: { contains: search, mode: "insensitive" } },
    ];
  }

  const skip = (page - 1) * pageSize;

  const [total, rows] = await Promise.all([
    prisma.reservation.count({ where }),
    prisma.reservation.findMany({
      where,
      orderBy,
      skip,
      take: pageSize,
      select: {
        id: true,
        guestName: true,
        guestEmail: true,
        roomName: true,
        checkIn: true,
        checkOut: true,
        status: true,
        source: true,
        externalProvider: true,
        externalId: true,
        property: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    }),
  ]);

  return res.json({
    page,
    pageSize,
    total,
    items: rows.map((r) => ({
      id: r.id,
      guestName: r.guestName,
      guestEmail: r.guestEmail ?? null,
      roomName: r.roomName ?? null,
      checkIn: r.checkIn.toISOString(),
      checkOut: r.checkOut.toISOString(),
      status: r.status,
      operationalStatus: getOperationalStatus(r),
      source: r.source ?? null,
      externalProvider: r.externalProvider ?? null,
      externalId: r.externalId ?? null,
      property: r.property,
    })),
  });
});

dashboardReservationsRouter.get(
  "/api/dashboard/reservations/:id",
  requireAuth,
  async (req, res) => {
    const user = (req as any).user;
    const orgId = user.orgId as string;
    const id = req.params.id;

    const reservation = await prisma.reservation.findFirst({
      where: {
        id,
        property: {
          organizationId: orgId,
        },
      },
      select: {
        id: true,
        guestName: true,
        guestEmail: true,
        roomName: true,
        checkIn: true,
        checkOut: true,
        status: true,
        property: {
          select: {
            id: true,
            name: true,
          },
        },
        accessGrants: {
          where: {
            type: AccessGrantType.GUEST,
          },
          orderBy: {
            startsAt: "asc",
          },
          select: {
            id: true,
            method: true,
            status: true,
            startsAt: true,
            endsAt: true,
            accessCodeMasked: true,
            ttlockKeyboardPwdId: true,
            lock: {
              select: {
                id: true,
                ttlockLockId: true,
              },
            },
          },
        },
        NfcAssignment: {
          orderBy: {
            startsAt: "asc",
          },
          select: {
            id: true,
            role: true,
            status: true,
            startsAt: true,
            endsAt: true,
            NfcCard: {
              select: {
                id: true,
                label: true,
                ttlockCardId: true,
              },
            },
          },
        },
      },
    });

    if (!reservation) {
      return res.status(404).json({
        error: "Reservation not found",
      });
    }

    return res.json({
      id: reservation.id,
      guestName: reservation.guestName,
      guestEmail: reservation.guestEmail ?? null,
      roomName: reservation.roomName ?? null,
      checkIn: reservation.checkIn.toISOString(),
      checkOut: reservation.checkOut.toISOString(),
      operationalStatus: getOperationalStatus(reservation),
      property: reservation.property
        ? {
            id: reservation.property.id,
            name: reservation.property.name,
          }
        : null,
      passcodes: reservation.accessGrants.map((g) => ({
        id: g.id,
        method: String(g.method),
        status: String(g.status),
        startsAt: g.startsAt.toISOString(),
        endsAt: g.endsAt.toISOString(),
        codeMasked: g.accessCodeMasked ?? null,
        ttlockKeyboardPwdId: g.ttlockKeyboardPwdId ?? null,
        lock: {
          id: g.lock.id,
          ttlockLockId: g.lock.ttlockLockId,
          name: null,
          property: reservation.property
            ? {
                id: reservation.property.id,
                name: reservation.property.name,
              }
            : {
                id: "",
                name: "—",
              },
        },
      })),
      nfc: reservation.NfcAssignment.map((a) => ({
        id: a.id,
        role: String(a.role),
        status: String(a.status),
        startsAt: a.startsAt.toISOString(),
        endsAt: a.endsAt.toISOString(),
        card: {
          id: a.NfcCard.id,
          label: a.NfcCard.label ?? null,
          ttlockCardId: a.NfcCard.ttlockCardId,
        },
      })),
    });
  }
);