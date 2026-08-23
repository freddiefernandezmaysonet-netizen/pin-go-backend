import { PrismaClient, ReservationStatus } from "@prisma/client";
import { fromZonedTime, formatInTimeZone } from "date-fns-tz";
import { calculateDirectBookingPricing } from "./direct-booking-pricing.service";
import { reconcileReservation } from "./reservation.reconcile.service";
import { persistChannexAriReservationIntent } from "../pms/outbound/channex-ari-reservation-producer.service";

const prisma = new PrismaClient();

export type ManualReservationDateChangeDependencies = {
  prisma: any;
  calculatePricing: typeof calculateDirectBookingPricing;
  reconcile: typeof reconcileReservation;
  persistChannexIntent: typeof persistChannexAriReservationIntent;
  now: () => Date;
};

const defaultDependencies: ManualReservationDateChangeDependencies = {
  prisma,
  calculatePricing: calculateDirectBookingPricing,
  reconcile: reconcileReservation,
  persistChannexIntent: persistChannexAriReservationIntent,
  now: () => new Date(),
};

function isDateOnly(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value.trim());
}

function buildPropertyDate(value: string, time: string, timezone: string) {
  const [hours, minutes] = String(time || "00:00").split(":").map(Number);
  const localDateTime = `${value.trim()}T${String(hours ?? 0).padStart(2, "0")}:${String(minutes ?? 0).padStart(2, "0")}:00`;
  return fromZonedTime(localDateTime, timezone);
}

function roundMoney(value: number) {
  return Math.round(value * 100) / 100;
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

async function prepareManualReservationDateChange(input: {
  organizationId: string;
  reservationId: string;
  checkInDate: string;
  checkOutDate: string;
}, dependencies: ManualReservationDateChangeDependencies = defaultDependencies) {
  if (!isDateOnly(input.checkInDate) || !isDateOnly(input.checkOutDate)) {
    throw new ManualReservationDateChangeError("INVALID_RESERVATION_DATES", "Check-in and check-out must use YYYY-MM-DD.", 400);
  }

  const reservation = await dependencies.prisma.reservation.findFirst({
    where: { id: input.reservationId, property: { organizationId: input.organizationId } },
    select: {
      id: true,
      reservationNumber: true,
      source: true,
      status: true,
      checkIn: true,
      checkOut: true,
      updatedAt: true,
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
  if (proposedCheckIn <= dependencies.now()) throw new ManualReservationDateChangeError("RESERVATION_DATE_CHANGE_REQUIRES_FUTURE_STAY", "Reservation dates must remain in the future.", 409);

  const conflictingReservation = await dependencies.prisma.reservation.findFirst({
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

  const pricing = await dependencies.calculatePricing({
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

  return {
    reservation,
    timezone,
    proposedCheckIn,
    proposedCheckOut,
    pricing,
    proposedTotal: roundMoney(proposedTotal),
    currentTotal: currentTotal == null ? null : roundMoney(currentTotal),
    currency,
  };
}

export async function previewManualReservationDateChangeByHost(input: {
  organizationId: string;
  reservationId: string;
  checkInDate: string;
  checkOutDate: string;
}, dependencies: ManualReservationDateChangeDependencies = defaultDependencies) {
  const prepared = await prepareManualReservationDateChange(input, dependencies);
  const nights = Number((prepared.pricing as any).nights ?? 0);

  return {
    ok: true,
    preview: {
      reservationUpdatedAt: prepared.reservation.updatedAt.toISOString(),
      current: {
        checkIn: prepared.reservation.checkIn.toISOString(),
        checkOut: prepared.reservation.checkOut.toISOString(),
        totalAmount: prepared.currentTotal,
        currency: prepared.currency,
      },
      proposed: {
        checkIn: prepared.proposedCheckIn.toISOString(),
        checkOut: prepared.proposedCheckOut.toISOString(),
        nights,
        totalAmount: prepared.proposedTotal,
        currency: prepared.currency,
      },
      difference: prepared.currentTotal == null ? null : roundMoney(prepared.proposedTotal - prepared.currentTotal),
      paymentHandledOutsidePinGo: true,
    },
  };
}

export async function changeManualReservationDatesByHost(input: {
  organizationId: string;
  reservationId: string;
  checkInDate: string;
  checkOutDate: string;
  requestedByUserId: string;
  expectedReservationUpdatedAt: string;
  expectedProposedTotalAmount: number;
}, dependencies: ManualReservationDateChangeDependencies = defaultDependencies) {
  if (!input.expectedReservationUpdatedAt || !Number.isFinite(Number(input.expectedProposedTotalAmount))) {
    throw new ManualReservationDateChangeError("DATE_CHANGE_PREVIEW_REQUIRED", "Review the proposed reservation change before confirming.", 409);
  }

  const prepared = await prepareManualReservationDateChange(input, dependencies);

  if (prepared.reservation.updatedAt.toISOString() !== input.expectedReservationUpdatedAt) {
    throw new ManualReservationDateChangeError("RESERVATION_CHANGED_REVIEW_REQUIRED", "The reservation changed after the preview. Review the change again before confirming.", 409);
  }

  if (roundMoney(Number(input.expectedProposedTotalAmount)) !== prepared.proposedTotal) {
    throw new ManualReservationDateChangeError("PRICING_CHANGED_REVIEW_REQUIRED", "Pricing changed after the preview. Review the updated total before confirming.", 409, {
      proposedTotalAmount: prepared.proposedTotal,
      currency: prepared.currency,
    });
  }

  const requestedAt = dependencies.now();
  const previous = { checkIn: prepared.reservation.checkIn, checkOut: prepared.reservation.checkOut, status: "ACTIVE" as const };
  const pricingBreakdown = JSON.parse(JSON.stringify({
    source: "MANUAL_RESERVATION_DATE_CHANGE",
    pricingSource: "PIN_GO_PRICING_ENGINE",
    paymentHandledOutsidePinGo: true,
    nights: (prepared.pricing as any).nights ?? null,
    nightlyRates: (prepared.pricing as any).nightlyRates ?? [],
    nightlySubtotal: (prepared.pricing as any).nightlySubtotal ?? null,
    cleaningFee: (prepared.pricing as any).cleaningFee ?? 0,
    amenitiesTotal: (prepared.pricing as any).amenitiesTotal ?? 0,
    taxesTotal: (prepared.pricing as any).taxesTotal ?? 0,
    taxableSubtotal: (prepared.pricing as any).taxableSubtotal ?? null,
    previousTotalAmount: prepared.currentTotal,
    totalAmount: prepared.proposedTotal,
    totalAmountCents: Math.round(prepared.proposedTotal * 100),
    currency: prepared.currency,
    calculatedAt: requestedAt.toISOString(),
    requestedByUserId: input.requestedByUserId,
  }));

  const updated = await dependencies.prisma.$transaction(async (tx: any) => {
    const row = await tx.reservation.update({
      where: { id: prepared.reservation.id },
      data: {
        checkIn: prepared.proposedCheckIn,
        checkOut: prepared.proposedCheckOut,
        totalAmount: prepared.proposedTotal,
        currency: prepared.currency,
        pricingBreakdown,
      },
      select: { id: true, reservationNumber: true, checkIn: true, checkOut: true, totalAmount: true, currency: true },
    });

    if (prepared.reservation.property.distributionEnabled === true && prepared.reservation.property.distributionStatus === "ACTIVE") {
      await dependencies.persistChannexIntent({
        db: tx,
        organizationId: prepared.reservation.property.organizationId,
        propertyId: prepared.reservation.propertyId,
        reservationId: prepared.reservation.id,
        previous,
        current: { checkIn: row.checkIn, checkOut: row.checkOut, status: "ACTIVE" },
        propertyTimezone: prepared.timezone,
        todayDateKey: formatInTimeZone(requestedAt, prepared.timezone, "yyyy-MM-dd"),
        now: requestedAt,
        coalesceMs: 0,
      });
    }
    return row;
  });

  await dependencies.reconcile(prepared.reservation.id);

  return {
    ok: true,
    reservation: {
      id: updated.id,
      reservationNumber: updated.reservationNumber,
      checkIn: updated.checkIn.toISOString(),
      checkOut: updated.checkOut.toISOString(),
      totalAmount: Number(updated.totalAmount ?? prepared.proposedTotal),
      currency: updated.currency ?? prepared.currency,
    },
    pricing: {
      currentTotalAmount: prepared.currentTotal,
      proposedTotalAmount: prepared.proposedTotal,
      difference: prepared.currentTotal == null ? null : roundMoney(prepared.proposedTotal - prepared.currentTotal),
      currency: prepared.currency,
      paymentHandledOutsidePinGo: true,
    },
  };
}
