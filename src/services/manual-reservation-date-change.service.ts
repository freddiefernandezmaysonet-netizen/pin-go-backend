import { PrismaClient, ReservationStatus } from "@prisma/client";
import { fromZonedTime, formatInTimeZone } from "date-fns-tz";
import { calculateDirectBookingPricing } from "./direct-booking-pricing.service";
import { reconcileReservation } from "./reservation.reconcile.service";
import { persistChannexAriReservationIntent } from "../pms/outbound/channex-ari-reservation-producer.service";

const prisma = new PrismaClient();

function isDateOnly(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value.trim());
}

function buildPropertyDate(value: string, time: string, timezone: string) {
  const [hours, minutes] = String(time || "00:00").split(":").map(Number);
  const localDateTime = `${value.trim()}T${String(hours ?? 0).padStart(2, "0")}:${String(minutes ?? 0).padStart(2, "0")}:00`;
  return fromZonedTime(localDateTime, timezone);
}

export class ManualReservationDateChangeError extends Error {
  statusCode: number;
  code: string;
  details?: unknown;

  constructor(code: string, message: string, statusCode = 400, details?: unknown) {
    super(message);
    this.name = "ManualReservationDateChangeError";
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

export async function changeManualReservationDatesByHost(input: {
  organizationId: string;
  reservationId: string;
  checkInDate: string;
  checkOutDate: string;
  requestedByUserId: string;
}) {
  if (!isDateOnly(input.checkInDate) || !isDateOnly(input.checkOutDate)) {
    throw new ManualReservationDateChangeError("INVALID_RESERVATION_DATES", "Check-in and check-out must use YYYY-MM-DD.", 400);
  }

  const reservation = await prisma.reservation.findFirst({
    where: { id: input.reservationId, property: { organizationId: input.organizationId } },
    select: {
      id: true,
      reservationNumber: true,
      source: true,
      status: true,
      checkIn: true,
      checkOut: true,
      totalAmount: true,
      currency: true,
      propertyId: true,
      selectedAmenityIds: true,
      property: {
        select: {
          organizationId: true,
          timezone: true,
          checkInTime: true,
          checkOutTime: true,
          distributionEnabled: true,
          distributionStatus: true,
        },
      },
    },
  });

  if (!reservation) throw new ManualReservationDateChangeError("MANUAL_RESERVATION_NOT_FOUND", "Manual reservation not found.", 404);
  if (reservation.status !== ReservationStatus.ACTIVE) throw new ManualReservationDateChangeError("MANUAL_RESERVATION_NOT_ACTIVE", "Only active manual reservations can be changed.", 409);
  if (String(reservation.source ?? "").toUpperCase() !== "MANUAL") throw new ManualReservationDateChangeError("MANUAL_RESERVATION_REQUIRED", "Only manual reservations can be changed with this action.", 409);

  const timezone = String(reservation.property.timezone ?? "").trim();
  if (!timezone) throw new ManualReservationDateChangeError("PROPERTY_TIMEZONE_REQUIRED", "Property timezone is required before changing reservation dates.", 409);

  const proposedCheckIn = buildPropertyDate(input.checkInDate, reservation.property.checkInTime ?? "16:00", timezone);
  const proposedCheckOut = buildPropertyDate(input.checkOutDate, reservation.property.checkOutTime ?? "11:00", timezone);

  if (Number.isNaN(proposedCheckIn.getTime()) || Number.isNaN(proposedCheckOut.getTime()) || proposedCheckOut <= proposedCheckIn) {
    throw new ManualReservationDateChangeError("INVALID_RESERVATION_DATES", "Check-in and check-out dates are invalid.", 400);
  }
  if (proposedCheckIn <= new Date()) throw new ManualReservationDateChangeError("RESERVATION_DATE_CHANGE_REQUIRES_FUTURE_STAY", "Reservation dates must remain in the future.", 409);

  const conflictingReservation = await prisma.reservation.findFirst({
    where: {
      id: { not: reservation.id },
      propertyId: reservation.propertyId,
      status: ReservationStatus.ACTIVE,
      checkIn: { lt: proposedCheckOut },
      checkOut: { gt: proposedCheckIn },
    },
    select: { id: true },
  });
  if (conflictingReservation) throw new ManualReservationDateChangeError("RESERVATION_DATE_CHANGE_CONFLICT", "The proposed dates conflict with another active reservation.", 409, { conflictingReservationId: conflictingReservation.id });

  const pricing = await calculateDirectBookingPricing({
    propertyId: reservation.propertyId,
    checkIn: proposedCheckIn,
    checkOut: proposedCheckOut,
    selectedAmenityIds: reservation.selectedAmenityIds ?? [],
    excludeReservationId: reservation.id,
  });

  const proposedTotal = Number((pricing as any).totalAmount ?? 0);
  const currency = String((pricing as any).currency ?? reservation.currency ?? "usd").trim().toLowerCase();
  const currentTotal = reservation.totalAmount == null ? null : Number(reservation.totalAmount);
  if (!Number.isFinite(proposedTotal) || proposedTotal < 0) throw new ManualReservationDateChangeError("MANUAL_RESERVATION_PRICING_INVALID", "Pin&Go could not calculate a valid total for the proposed dates.", 409);

  const requestedAt = new Date();
  const previous = { checkIn: reservation.checkIn, checkOut: reservation.checkOut, status: "ACTIVE" as const };
  const pricingBreakdown = JSON.parse(JSON.stringify({
    source: "MANUAL_RESERVATION_DATE_CHANGE",
    pricingSource: "PIN_GO_PRICING_ENGINE",
    paymentHandledOutsidePinGo: true,
    nights: (pricing as any).nights ?? null,
    nightlyRates: (pricing as any).nightlyRates ?? [],
    nightlySubtotal: (pricing as any).nightlySubtotal ?? null,
    cleaningFee: (pricing as any).cleaningFee ?? 0,
    amenitiesTotal: (pricing as any).amenitiesTotal ?? 0,
    taxesTotal: (pricing as any).taxesTotal ?? 0,
    taxableSubtotal: (pricing as any).taxableSubtotal ?? null,
    previousTotalAmount: currentTotal,
    totalAmount: proposedTotal,
    totalAmountCents: Math.round(proposedTotal * 100),
    currency,
    calculatedAt: requestedAt.toISOString(),
    requestedByUserId: input.requestedByUserId,
  }));

  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.reservation.update({
      where: { id: reservation.id },
      data: { checkIn: proposedCheckIn, checkOut: proposedCheckOut, totalAmount: proposedTotal, currency, pricingBreakdown },
      select: { id: true, reservationNumber: true, checkIn: true, checkOut: true, totalAmount: true, currency: true },
    });

    if (reservation.property.distributionEnabled === true && reservation.property.distributionStatus === "ACTIVE") {
      await persistChannexAriReservationIntent({
        db: tx,
        organizationId: reservation.property.organizationId,
        propertyId: reservation.propertyId,
        reservationId: reservation.id,
        previous,
        current: { checkIn: row.checkIn, checkOut: row.checkOut, status: "ACTIVE" },
        propertyTimezone: timezone,
        todayDateKey: formatInTimeZone(requestedAt, timezone, "yyyy-MM-dd"),
        now: requestedAt,
        coalesceMs: 0,
      });
    }
    return row;
  });

  await reconcileReservation(reservation.id);

  return {
    ok: true,
    reservation: {
      id: updated.id,
      reservationNumber: updated.reservationNumber,
      checkIn: updated.checkIn.toISOString(),
      checkOut: updated.checkOut.toISOString(),
      totalAmount: Number(updated.totalAmount ?? proposedTotal),
      currency: updated.currency ?? currency,
    },
    pricing: {
      currentTotalAmount: currentTotal,
      proposedTotalAmount: proposedTotal,
      difference: currentTotal == null ? null : Math.round((proposedTotal - currentTotal) * 100) / 100,
      currency,
      paymentHandledOutsidePinGo: true,
    },
  };
}
