import {
  PrismaClient,
  ReservationStatus,
  AccessGrantType,
  PaymentState,
} from "@prisma/client";
import { Router } from "express";
import { requireAuth } from "../middleware/requireAuth";
import {
  DirectBookingRefundError,
  refundDirectBookingReservation,
} from "../services/direct-booking-refund.service";

const prisma = new PrismaClient();
export const dashboardReservationsRouter = Router();

function getOperationalStatus(r: {
  status: ReservationStatus;
  checkIn: Date;
  checkOut: Date;
}) {
  const nowMs = Date.now();
  const checkInMs = r.checkIn.getTime();
  const checkOutMs = r.checkOut.getTime();

  if (r.status === ReservationStatus.CANCELLED) return "CANCELLED";
  if (nowMs < checkInMs) return "UPCOMING";
  if (nowMs >= checkInMs && nowMs < checkOutMs) return "IN_HOUSE";
  return "CHECKED_OUT";
}

function toInt(v: any, def: number) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

const SOURCE_FILTER_ALIASES: Record<string, string[]> = {
  PIN_GO_DIRECT: ["DIRECT_BOOKING", "PIN_GO_DIRECT"],
  PIN_GO_MANUAL: ["MANUAL", "PIN_GO_MANUAL"],
  AIRBNB: ["AIRBNB", "AIR_BNB"],
  VRBO: ["VRBO"],
  BOOKING_COM: ["BOOKING_COM", "BOOKINGCOM", "BOOKING.COM"],
};


dashboardReservationsRouter.get("/api/dashboard/reservations", requireAuth, async (req, res) => {
  const user = (req as any).user;
  const orgId = user.orgId as string;

  const propertyId =
    typeof req.query.propertyId === "string" ? req.query.propertyId : undefined;
  const statusQ =
    typeof req.query.status === "string" ? req.query.status : undefined;
  const operationalStatusQ =
    typeof req.query.operationalStatus === "string"
      ? req.query.operationalStatus
      : undefined;
  const paymentStateQ =
    typeof req.query.paymentState === "string"
      ? req.query.paymentState
      : undefined;
  const sourceQ =
    typeof req.query.source === "string" ? req.query.source.trim() : "";
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

  const operationalStatus =
    operationalStatusQ === "UPCOMING" ||
    operationalStatusQ === "IN_HOUSE" ||
    operationalStatusQ === "CHECKED_OUT" ||
    operationalStatusQ === "CANCELLED"
      ? operationalStatusQ
      : undefined;

  const paymentState = Object.values(PaymentState).includes(
    paymentStateQ as PaymentState
  )
    ? (paymentStateQ as PaymentState)
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

  if (operationalStatus === "CANCELLED") {
    where.status = ReservationStatus.CANCELLED;
  } else if (operationalStatus) {
    const now = new Date();

    where.status = ReservationStatus.ACTIVE;

    if (operationalStatus === "UPCOMING") {
      where.checkIn = { gt: now };
    } else if (operationalStatus === "IN_HOUSE") {
      where.checkIn = { lte: now };
      where.checkOut = { gt: now };
    } else if (operationalStatus === "CHECKED_OUT") {
      where.checkOut = { lte: now };
    }
  } else if (status) {
    where.status = status;
  }

  if (paymentState) {
    where.paymentState = paymentState;
  }

  if (sourceQ) {
    const sourceAliases = SOURCE_FILTER_ALIASES[sourceQ.toUpperCase()];

    where.source = sourceAliases
      ? { in: sourceAliases, mode: "insensitive" }
      : { equals: sourceQ, mode: "insensitive" };
  }

  if (from || to) {
    where.AND = [];
    if (to) where.AND.push({ checkIn: { lt: to } });
    if (from) where.AND.push({ checkOut: { gt: from } });
  }

  if (search) {
   where.OR = [
  { reservationNumber: { contains: search, mode: "insensitive" } },
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
        reservationNumber: true,
        guestName: true,
        guestEmail: true,
        guestPhone: true,
        roomName: true,
        checkIn: true,
        checkOut: true,
        status: true,
        paymentState: true,
        totalAmount: true,
        currency: true,
        source: true,
        externalProvider: true,
        externalId: true,
        selectedAmenityIds: true,
        pricingBreakdown: true,
        stripeCheckoutSessionId: true,
        stripePaymentIntentId: true,
          property: {
          select: {
            id: true,
            name: true,
            timezone: true,
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
      reservationNumber: r.reservationNumber,
      guestName: r.guestName,
      guestEmail: r.guestEmail ?? null,
      roomName: r.roomName ?? null,
      checkIn: r.checkIn.toISOString(),
      checkOut: r.checkOut.toISOString(),    
      status: r.status,
      paymentState: r.paymentState,
      totalAmount: r.totalAmount ? Number(r.totalAmount) : null,
      operationalStatus: getOperationalStatus(r),
      source: r.source ?? null,
      externalProvider: r.externalProvider ?? null,
      externalId: r.externalId ?? null,
      property: r.property
  ? {
      id: r.property.id,
      name: r.property.name,
      timezone: r.property.timezone,
    }
  : null,
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
        reservationNumber: true,
        guestName: true,
        guestEmail: true,
        roomName: true,
        checkIn: true,
        checkOut: true,
        status: true,
        paymentState: true,
        totalAmount: true,
        currency: true,
        source: true,
        externalProvider: true,
        externalId: true,
        selectedAmenityIds: true,
        pricingBreakdown: true,
        stripeCheckoutSessionId: true,
        stripePaymentIntentId: true,
        property: {
          select: {
            id: true,
            name: true,
            timezone: true,
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
      reservationNumber: reservation.reservationNumber,
      guestName: reservation.guestName,
      guestEmail: reservation.guestEmail ?? null,
      guestPhone: reservation.guestPhone ?? null,
      roomName: reservation.roomName ?? null,
      checkIn: reservation.checkIn.toISOString(),
      checkOut: reservation.checkOut.toISOString(),     
      operationalStatus: getOperationalStatus(reservation),
      paymentState: reservation.paymentState,
      status: reservation.status,
      totalAmount: reservation.totalAmount ? Number(reservation.totalAmount) : null,
      currency: reservation.currency ?? "usd",
      source: reservation.source ?? null,
      externalProvider: reservation.externalProvider ?? null,
      externalId: reservation.externalId ?? null,
      selectedAmenityIds: reservation.selectedAmenityIds ?? [],
      pricingBreakdown: reservation.pricingBreakdown ?? null,
      stripeCheckoutSessionId: reservation.stripeCheckoutSessionId ?? null,
      stripePaymentIntentId: reservation.stripePaymentIntentId ?? null,
      property: reservation.property
        ? {
            id: reservation.property.id,
            name: reservation.property.name,
            timezone: reservation.property.timezone,
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

dashboardReservationsRouter.post(
  "/api/dashboard/reservations/:id/refund",
  requireAuth,
  async (req, res) => {
    try {
      const user = (req as any).user;
      const orgId = user.orgId as string;
      const reservationId = String(req.params.id ?? "").trim();

      if (!reservationId) {
        return res.status(400).json({
          ok: false,
          error: "MISSING_RESERVATION_ID",
          message: "Missing reservation id.",
        });
      }

      const reason =
        typeof req.body?.reason === "string" ? req.body.reason.trim() : "";

      const requestedByUserId =
        typeof user.id === "string"
          ? user.id
          : typeof user.userId === "string"
          ? user.userId
          : null;

      const result = await refundDirectBookingReservation({
        organizationId: orgId,
        reservationId,
        reason,
        refundMode: "FULL",
        requestedByUserId,
      });

      return res.json(result);
    } catch (error: any) {
      console.error("[DASHBOARD_RESERVATION_REFUND_ERROR]", error);

      if (error instanceof DirectBookingRefundError || error?.code) {
        return res.status(error?.statusCode || 400).json({
          ok: false,
          error: error?.code || "DIRECT_BOOKING_REFUND_ERROR",
          message:
            error?.message ||
            "Unable to refund this direct booking reservation.",
          details: error?.details,
        });
      }

      return res.status(500).json({
        ok: false,
        error: "DASHBOARD_RESERVATION_REFUND_ERROR",
        message: "Unable to refund this direct booking reservation.",
      });
    }
  }
);
