import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import type { PinAIRuntimeRequest } from "./contracts.js";

type EligibilityPrisma = Readonly<{
  reservation: Readonly<{
    findFirst(args: unknown): Promise<any>;
  }>;
  cleaningConfirmation: Readonly<{
    findFirst(args: unknown): Promise<any>;
  }>;
  propertyBlockedDate: Readonly<{
    findFirst(args: unknown): Promise<any>;
  }>;
  reservationModification: Readonly<{
    findFirst(args: unknown): Promise<any>;
  }>;
}>;

type StaySnapshot = Readonly<{
  id: string;
  propertyId: string;
  checkIn: Date;
  checkOut: Date;
  property: Readonly<{
    organizationId: string;
    timezone: string | null;
    checkInTime: string | null;
    checkOutTime: string | null;
    cleaningDurationMinutes: number;
  }>;
}>;

export class PinGoRuntimeEligibilityChecks {
  constructor(
    private readonly prisma: EligibilityPrisma,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async checkEarlyCheckin(
    request: PinAIRuntimeRequest,
    args: Readonly<Record<string, unknown>>,
  ): Promise<Readonly<Record<string, unknown>>> {
    const stay = await this.loadStay(request);
    const requestedLocalTime = parseLocalTime(args.requestedLocalTime);

    if (!requestedLocalTime) {
      return {
        decision: "REQUESTED_TIME_REQUIRED",
        authorizationGranted: false,
        reason: "EARLY_CHECKIN_TIME_NOT_PROVIDED",
      };
    }

    const timezone = requireTimezone(stay);
    const checkInDateKey = formatInTimeZone(stay.checkIn, timezone, "yyyy-MM-dd");
    const requestedAt = fromZonedTime(
      `${checkInDateKey}T${requestedLocalTime}:00`,
      timezone,
    );

    if (requestedAt >= stay.checkIn) {
      return {
        decision: "NOT_AN_EARLY_CHECKIN",
        authorizationGranted: false,
        requestedAt,
        scheduledCheckIn: stay.checkIn,
      };
    }

    const overlappingPriorStay = await this.prisma.reservation.findFirst({
      where: {
        id: { not: stay.id },
        propertyId: stay.propertyId,
        status: "ACTIVE",
        checkIn: { lt: stay.checkIn },
        checkOut: { gt: requestedAt },
      },
      orderBy: { checkOut: "desc" },
      select: {
        checkOut: true,
      },
    });

    if (overlappingPriorStay) {
      return {
        decision: "NOT_OPERATIONALLY_AVAILABLE",
        authorizationGranted: false,
        reason: "PRIOR_STAY_OVERLAPS_REQUESTED_ARRIVAL",
        requestedAt,
        priorStayCheckOut: overlappingPriorStay.checkOut,
      };
    }

    const cleaning = await this.prisma.cleaningConfirmation.findFirst({
      where: {
        reservationId: stay.id,
        propertyId: stay.propertyId,
      },
      orderBy: { createdAt: "desc" },
      select: {
        status: true,
        updatedAt: true,
      },
    });

    if (cleaning?.status !== "CONFIRMED") {
      return {
        decision: "WAITING_FOR_CLEANING_READINESS",
        authorizationGranted: false,
        requestedAt,
        cleaningStatus: cleaning?.status ?? "NOT_REQUESTED",
      };
    }

    return {
      decision: "OPERATIONALLY_AVAILABLE_FOR_REVIEW",
      authorizationGranted: false,
      requestedAt,
      scheduledCheckIn: stay.checkIn,
      cleaningStatus: "CONFIRMED",
      note: "Runtime V1 evaluates operational availability only; it does not approve early check-in.",
    };
  }

  async checkLateCheckout(
    request: PinAIRuntimeRequest,
    args: Readonly<Record<string, unknown>>,
  ): Promise<Readonly<Record<string, unknown>>> {
    const stay = await this.loadStay(request);
    const requestedLocalTime = parseLocalTime(args.requestedLocalTime);

    if (!requestedLocalTime) {
      return {
        decision: "REQUESTED_TIME_REQUIRED",
        authorizationGranted: false,
        reason: "LATE_CHECKOUT_TIME_NOT_PROVIDED",
      };
    }

    const timezone = requireTimezone(stay);
    const checkOutDateKey = formatInTimeZone(stay.checkOut, timezone, "yyyy-MM-dd");
    const requestedAt = fromZonedTime(
      `${checkOutDateKey}T${requestedLocalTime}:00`,
      timezone,
    );

    if (requestedAt <= stay.checkOut) {
      return {
        decision: "NOT_A_LATE_CHECKOUT",
        authorizationGranted: false,
        requestedAt,
        scheduledCheckOut: stay.checkOut,
      };
    }

    const cleaningDurationMinutes = Math.max(
      0,
      Number(stay.property.cleaningDurationMinutes ?? 0),
    );
    const cleaningWouldEndAt = new Date(
      requestedAt.getTime() + cleaningDurationMinutes * 60_000,
    );

    const nextStay = await this.prisma.reservation.findFirst({
      where: {
        id: { not: stay.id },
        propertyId: stay.propertyId,
        status: "ACTIVE",
        checkIn: { gte: stay.checkOut },
      },
      orderBy: { checkIn: "asc" },
      select: {
        checkIn: true,
      },
    });

    if (nextStay && cleaningWouldEndAt > nextStay.checkIn) {
      return {
        decision: "NOT_OPERATIONALLY_AVAILABLE",
        authorizationGranted: false,
        reason: "REQUIRED_CLEANING_WINDOW_CONFLICTS_WITH_NEXT_STAY",
        requestedAt,
        cleaningDurationMinutes,
        cleaningWouldEndAt,
        nextStayCheckIn: nextStay.checkIn,
      };
    }

    return {
      decision: "OPERATIONALLY_AVAILABLE_FOR_REVIEW",
      authorizationGranted: false,
      requestedAt,
      scheduledCheckOut: stay.checkOut,
      cleaningDurationMinutes,
      nextStayCheckIn: nextStay?.checkIn ?? null,
      note: "Runtime V1 evaluates operational availability only; it does not approve late checkout.",
    };
  }

  async checkExtensionAvailability(
    request: PinAIRuntimeRequest,
    args: Readonly<Record<string, unknown>>,
  ): Promise<Readonly<Record<string, unknown>>> {
    const stay = await this.loadStay(request);
    const additionalNights = parseAdditionalNights(args.additionalNights);

    if (!additionalNights) {
      return {
        decision: "ADDITIONAL_NIGHTS_REQUIRED",
        authorizationGranted: false,
      };
    }

    const proposedCheckOut = addLocalCalendarDays(
      stay.checkOut,
      requireTimezone(stay),
      additionalNights,
    );

    const reservationConflict = await this.prisma.reservation.findFirst({
      where: {
        id: { not: stay.id },
        propertyId: stay.propertyId,
        status: "ACTIVE",
        checkIn: { lt: proposedCheckOut },
        checkOut: { gt: stay.checkOut },
      },
      select: {
        checkIn: true,
        checkOut: true,
      },
    });

    if (reservationConflict) {
      return {
        decision: "NOT_AVAILABLE",
        authorizationGranted: false,
        reason: "ACTIVE_RESERVATION_CONFLICT",
        proposedCheckOut,
        conflict: reservationConflict,
      };
    }

    const modificationHold = await this.prisma.reservationModification.findFirst({
      where: {
        reservation: {
          propertyId: stay.propertyId,
        },
        proposedCheckIn: { lt: proposedCheckOut },
        proposedCheckOut: { gt: stay.checkOut },
        OR: [
          { status: "PAYMENT_PROCESSING" },
          {
            status: "AWAITING_PAYMENT",
            checkoutExpiresAt: { gt: this.now() },
          },
        ],
      },
      select: {
        proposedCheckIn: true,
        proposedCheckOut: true,
        status: true,
        checkoutExpiresAt: true,
      },
    });

    if (modificationHold) {
      return {
        decision: "NOT_AVAILABLE",
        authorizationGranted: false,
        reason: "RESERVATION_MODIFICATION_HOLD",
        proposedCheckOut,
      };
    }

    const blockedDate = await this.prisma.propertyBlockedDate.findFirst({
      where: {
        propertyId: stay.propertyId,
        startDate: { lt: proposedCheckOut },
        endDate: { gt: stay.checkOut },
      },
      select: {
        startDate: true,
        endDate: true,
        reason: true,
      },
    });

    if (blockedDate) {
      return {
        decision: "NOT_AVAILABLE",
        authorizationGranted: false,
        reason: "PROPERTY_BLOCKED_DATE",
        proposedCheckOut,
        blockedWindow: blockedDate,
      };
    }

    return {
      decision: "CALENDAR_AVAILABLE_FOR_PRICING",
      authorizationGranted: false,
      additionalNights,
      currentCheckOut: stay.checkOut,
      proposedCheckOut,
      pricingRequired: true,
      note: "Availability does not authorize a reservation change or payment.",
    };
  }

  private async loadStay(request: PinAIRuntimeRequest): Promise<StaySnapshot> {
    const stay = await this.prisma.reservation.findFirst({
      where: {
        id: request.context.reservationId,
        propertyId: request.context.propertyId,
        status: "ACTIVE",
        property: {
          organizationId: request.context.organizationId,
        },
      },
      select: {
        id: true,
        propertyId: true,
        checkIn: true,
        checkOut: true,
        property: {
          select: {
            organizationId: true,
            timezone: true,
            checkInTime: true,
            checkOutTime: true,
            cleaningDurationMinutes: true,
          },
        },
      },
    });

    if (!stay) {
      throw new Error("PIN_AI_RUNTIME_ACTIVE_STAY_NOT_FOUND_OR_OUT_OF_SCOPE");
    }

    return stay;
  }
}

function requireTimezone(stay: StaySnapshot): string {
  const timezone = String(stay.property.timezone ?? "").trim();
  if (!timezone) {
    throw new Error("PIN_AI_RUNTIME_PROPERTY_TIMEZONE_REQUIRED");
  }
  return timezone;
}

function parseLocalTime(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(trimmed)) return null;
  return trimmed;
}

function parseAdditionalNights(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  if (value < 1 || value > 30) return null;
  return value;
}

function addLocalCalendarDays(
  value: Date,
  timezone: string,
  days: number,
): Date {
  const localDateKey = formatInTimeZone(value, timezone, "yyyy-MM-dd");
  const localTime = formatInTimeZone(value, timezone, "HH:mm:ss.SSS");
  const [year, month, day] = localDateKey.split("-").map(Number);
  const shiftedDateKey = new Date(
    Date.UTC(year, month - 1, day + days),
  )
    .toISOString()
    .slice(0, 10);

  return fromZonedTime(`${shiftedDateKey}T${localTime}`, timezone);
}
