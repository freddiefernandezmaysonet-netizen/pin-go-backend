import {
  PrismaClient,
  ReservationStatus,
  AccessGrantType,
} from "@prisma/client";
import { Router } from "express";
import { formatInTimeZone } from "date-fns-tz";
import { requireAuth } from "../middleware/requireAuth";
import { persistChannexAriReservationIntent } from "../pms/outbound/channex-ari-reservation-producer.service";
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

function parseReservationDate(value: unknown) {
  const normalized = String(value ?? "").trim();
  if (!normalized) return null;

  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
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

dashboardReservationsRouter.patch(
  "/api/dashboard/reservations/:id/dates",
  requireAuth,
  async (req, res) => {
    try {
      const user = (req as any).user;
      const orgId = String(user.orgId ?? "").trim();
      const reservationId = String(req.params.id ?? "").trim();
      const proposedCheckIn = parseReservationDate(req.body?.checkIn);
      const proposedCheckOut = parseReservationDate(req.body?.checkOut);
      const requestedAt = new Date();

      if (!reservationId) {
        return res.status(400).json({
          ok: false,
          error: "MISSING_RESERVATION_ID",
          message: "Missing reservation id.",
        });
      }

      if (!proposedCheckIn || !proposedCheckOut || proposedCheckOut <= proposedCheckIn) {
        return res.status(400).json({
          ok: false,
          error: "INVALID_RESERVATION_DATES",
          message: "Check-in and check-out dates are invalid.",
        });
      }

      if (proposedCheckIn <= requestedAt) {
        return res.status(409).json({
          ok: false,
          error: "RESERVATION_DATE_CHANGE_REQUIRES_FUTURE_STAY",
          message: "Reservation dates must remain in the future.",
        });
      }

      const result = await prisma.$transaction(async (tx) => {
        const reservation = await tx.reservation.findFirst({
          where: {
            id: reservationId,
            property: {
              organizationId: orgId,
            },
          },
          select: {
            id: true,
            source: true,
            status: true,
            checkIn: true,
            checkOut: true,
            propertyId: true,
            property: {
              select: {
                organizationId: true,
                timezone: true,
                distributionEnabled: true,
                distributionStatus: true,
              },
            },
          },
        });

        if (!reservation) {
          return {
            kind: "NOT_FOUND" as const,
          };
        }

        if (reservation.status !== ReservationStatus.ACTIVE) {
          return {
            kind: "NOT_ACTIVE" as const,
          };
        }

        if (String(reservation.source ?? "").toUpperCase() !== "MANUAL") {
          return {
            kind: "NOT_MANUAL" as const,
          };
        }

        if (
          reservation.checkIn.getTime() === proposedCheckIn.getTime() &&
          reservation.checkOut.getTime() === proposedCheckOut.getTime()
        ) {
          return {
            kind: "UNCHANGED" as const,
            reservation,
          };
        }

        const conflictingReservation = await tx.reservation.findFirst({
          where: {
            id: { not: reservation.id },
            propertyId: reservation.propertyId,
            status: ReservationStatus.ACTIVE,
            checkIn: { lt: proposedCheckOut },
            checkOut: { gt: proposedCheckIn },
          },
          select: { id: true },
        });

        if (conflictingReservation) {
          return {
            kind: "CONFLICT" as const,
          };
        }

        const previous = {
          checkIn: reservation.checkIn,
          checkOut: reservation.checkOut,
          status: "ACTIVE" as const,
        };

        const updated = await tx.reservation.update({
          where: { id: reservation.id },
          data: {
            checkIn: proposedCheckIn,
            checkOut: proposedCheckOut,
          },
          select: {
            id: true,
            reservationNumber: true,
            checkIn: true,
            checkOut: true,
            status: true,
          },
        });

        if (
          reservation.property.distributionEnabled === true &&
          reservation.property.distributionStatus === "ACTIVE"
        ) {
          const propertyTimezone =
            reservation.property.timezone ?? "America/Puerto_Rico";
          const todayDateKey = formatInTimeZone(
            requestedAt,
            propertyTimezone,
            "yyyy-MM-dd"
          );

          await persistChannexAriReservationIntent({
            db: tx,
            organizationId: reservation.property.organizationId,
            propertyId: reservation.propertyId,
            reservationId: reservation.id,
            previous,
            current: {
              checkIn: updated.checkIn,
              checkOut: updated.checkOut,
              status: "ACTIVE",
            },
            propertyTimezone,
            todayDateKey,
            now: requestedAt,
            coalesceMs: 0,
          });
        }

        return {
          kind: "UPDATED" as const,
          reservation: updated,
        };
      });

      if (result.kind === "NOT_FOUND") {
        return res.status(404).json({
          ok: false,
          error: "RESERVATION_NOT_FOUND",
          message: "Reservation not found.",
        });
      }

      if (result.kind === "NOT_ACTIVE") {
        return res.status(409).json({
          ok: false,
          error: "RESERVATION_NOT_ACTIVE",
          message: "Only active reservations can be moved.",
        });
      }

      if (result.kind === "NOT_MANUAL") {
        return res.status(409).json({
          ok: false,
          error: "MANUAL_RESERVATION_REQUIRED",
          message: "This date-change action is limited to manual reservations.",
        });
      }

      if (result.kind === "CONFLICT") {
        return res.status(409).json({
          ok: false,
          error: "PROPERTY_NOT_AVAILABLE",
          message: "The property is not available for the selected dates.",
        });
      }

      if (result.kind === "UNCHANGED") {
        return res.json({
          ok: true,
          changed: false,
          reservation: {
            id: result.reservation.id,
            checkIn: result.reservation.checkIn.toISOString(),
            checkOut: result.reservation.checkOut.toISOString(),
          },
        });
      }

      return res.json({
        ok: true,
        changed: true,
        reservation: {
          id: result.reservation.id,
          reservationNumber: result.reservation.reservationNumber,
          checkIn: result.reservation.checkIn.toISOString(),
          checkOut: result.reservation.checkOut.toISOString(),
        },
      });
    } catch (error: any) {
      console.error("[DASHBOARD_RESERVATION_DATE_CHANGE_ERROR]", error);
      return res.status(500).json({
        ok: false,
        error: "DASHBOARD_RESERVATION_DATE_CHANGE_ERROR",
        message: "Unable to update reservation dates.",
      });
    }
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