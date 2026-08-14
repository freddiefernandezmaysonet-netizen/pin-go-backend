import { createHash } from "node:crypto";
import {
  PaymentState,
  PrismaClient,
  ReservationModificationFinancialAction,
  ReservationModificationStatus,
  ReservationStatus,
} from "@prisma/client";

import { checkPropertyAvailability } from "./availability.service";
import { calculateDirectBookingModificationConnectFee } from "./direct-booking-connect-fee.service";
import { calculateDirectBookingPricing } from "./direct-booking-pricing.service";

const prisma = new PrismaClient();

type GuestReservationModificationPreviewInput = {
  guestToken: string;
  checkIn: Date;
  checkOut: Date;
  adults: number;
  children: number;
  selectedAmenityIds?: string[];
};

type GuestReservationModificationConfirmInput =
  GuestReservationModificationPreviewInput & {
    clientRequestId: string;
    acceptNoRefundReduction?: boolean;
  };

type JsonObject = Record<string, unknown>;

export class GuestReservationModificationError extends Error {
  code: string;
  statusCode: number;
  details: unknown;

  constructor(input: {
    code: string;
    message: string;
    statusCode: number;
    details?: unknown;
  }) {
    super(input.message);
    this.name = "GuestReservationModificationError";
    this.code = input.code;
    this.statusCode = input.statusCode;
    this.details = input.details ?? null;
  }
}

function normalizeJsonObject(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return value as JsonObject;
}

function normalizeGuestToken(value: unknown) {
  return String(value ?? "").trim();
}

function normalizeClientRequestId(value: unknown) {
  const clientRequestId = String(value ?? "").trim();

  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/.test(clientRequestId)) {
    throw new GuestReservationModificationError({
      code: "INVALID_CLIENT_REQUEST_ID",
      message: "A valid client request ID is required.",
      statusCode: 400,
    });
  }

  return clientRequestId;
}

function normalizeSelectedAmenityIds(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  return Array.from(
    new Set(value.map((id) => String(id).trim()).filter(Boolean))
  ).sort();
}

function parseGuestCount(value: unknown, fallback: number) {
  const count = Number(value);

  return Number.isInteger(count) && count >= 0 ? count : fallback;
}

function sameStringSet(left: string[], right: string[]) {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((value, index) => value === right[index]);
}

export function buildGuestReservationModificationRequestFingerprint(input: {
  checkIn: Date;
  checkOut: Date;
  adults: number;
  children: number;
  selectedAmenityIds: string[];
  acceptNoRefundReduction: boolean;
}) {
  if (
    !(input.checkIn instanceof Date) ||
    Number.isNaN(input.checkIn.getTime()) ||
    !(input.checkOut instanceof Date) ||
    Number.isNaN(input.checkOut.getTime())
  ) {
    throw new GuestReservationModificationError({
      code: "INVALID_STAY_DATES",
      message: "Missing or invalid check-in/check-out dates.",
      statusCode: 400,
    });
  }

  const canonicalRequest = JSON.stringify({
    checkIn: input.checkIn.toISOString(),
    checkOut: input.checkOut.toISOString(),
    adults: input.adults,
    children: input.children,
    selectedAmenityIds: normalizeSelectedAmenityIds(
      input.selectedAmenityIds
    ),
    acceptNoRefundReduction: input.acceptNoRefundReduction,
  });

  return createHash("sha256").update(canonicalRequest).digest("hex");
}

function getModificationPlatformFeePercent() {
  const raw = Number(
    process.env.PINGO_DIRECT_BOOKING_PLATFORM_FEE_PERCENT ?? "0"
  );

  return Number.isFinite(raw) ? Math.max(0, raw) : 0;
}

export function getGuestReservationModificationInitialStatus(
  financialAction: ReservationModificationFinancialAction
) {
  switch (financialAction) {
    case ReservationModificationFinancialAction.ADDITIONAL_PAYMENT_REQUIRED:
      return ReservationModificationStatus.AWAITING_PAYMENT;
    case ReservationModificationFinancialAction.REDUCTION_REVIEW_REQUIRED:
      return ReservationModificationStatus.HOST_APPROVAL_REQUIRED;
    case ReservationModificationFinancialAction.NO_PAYMENT_REQUIRED:
    case ReservationModificationFinancialAction.NO_REFUND_DUE_CONFIRMATION_REQUIRED:
      return ReservationModificationStatus.APPLYING;
  }
}

function serializeReservationModification(modification: any) {
  const nextAction =
    modification.status === ReservationModificationStatus.AWAITING_PAYMENT
      ? "CREATE_ADDITIONAL_PAYMENT_CHECKOUT"
      : modification.status ===
          ReservationModificationStatus.HOST_APPROVAL_REQUIRED
        ? "WAIT_FOR_HOST_APPROVAL"
        : modification.status === ReservationModificationStatus.APPLYING
          ? "APPLY_RESERVATION_CHANGE"
          : "NONE";

  return {
    id: modification.id,
    status: modification.status,
    financialAction: modification.financialAction,
    currency: modification.currency,
    currentTotalAmount: Number(modification.currentTotalAmount),
    proposedTotalAmount: Number(modification.proposedTotalAmount),
    amountDifference: Number(modification.amountDifference),
    additionalChargeAmount: Number(modification.additionalChargeAmount),
    additionalPlatformFeeAmount: Number(
      modification.additionalPlatformFeeAmount
    ),
    additionalHostPayoutAmount: Number(
      modification.additionalHostPayoutAmount
    ),
    checkoutExpiresAt: modification.checkoutExpiresAt,
    appliedAt: modification.appliedAt,
    createdAt: modification.createdAt,
    nextAction,
  };
}

function isDirectBookingReservation(reservation: {
  source: string | null;
  externalProvider: string | null;
  stripeCheckoutSessionId: string | null;
}) {
  return (
    reservation.source === "DIRECT_BOOKING" ||
    reservation.externalProvider === "PIN_GO_DIRECT" ||
    Boolean(reservation.stripeCheckoutSessionId)
  );
}

async function getEligibleReservationByGuestToken(
  guestTokenInput: unknown,
  now = new Date()
) {
  const guestToken = normalizeGuestToken(guestTokenInput);

  if (!guestToken) {
    throw new GuestReservationModificationError({
      code: "MISSING_GUEST_TOKEN",
      message: "Missing guest reservation token.",
      statusCode: 400,
    });
  }

  const reservation = await prisma.reservation.findFirst({
    where: {
      guestToken,
      OR: [
        { guestTokenExpiresAt: null },
        { guestTokenExpiresAt: { gt: now } },
      ],
    },
    include: {
      property: {
        select: {
          id: true,
          name: true,
          status: true,
          isPublicBookable: true,
          maxGuests: true,
          minimumNights: true,
          maximumNights: true,
          timezone: true,
          checkInTime: true,
          checkOutTime: true,
          amenities: {
            where: {
              isActive: true,
              chargeMode: "OPTIONAL",
            },
            select: {
              id: true,
              name: true,
              description: true,
              feeType: true,
              amount: true,
            },
            orderBy: { name: "asc" },
          },
        },
      },
    },
  });

  if (!reservation) {
    throw new GuestReservationModificationError({
      code: "RESERVATION_NOT_FOUND_OR_TOKEN_EXPIRED",
      message: "Reservation not found or guest link has expired.",
      statusCode: 404,
    });
  }

  if (!isDirectBookingReservation(reservation)) {
    throw new GuestReservationModificationError({
      code: "NOT_DIRECT_BOOKING_RESERVATION",
      message: "Only Pin&Go Direct Booking reservations can be modified here.",
      statusCode: 400,
    });
  }

  if (
    reservation.status !== ReservationStatus.ACTIVE ||
    reservation.paymentState !== PaymentState.PAID ||
    reservation.checkIn <= now
  ) {
    throw new GuestReservationModificationError({
      code: "RESERVATION_NOT_ELIGIBLE_FOR_MODIFICATION",
      message: "This reservation can no longer be modified online.",
      statusCode: 409,
      details: {
        status: reservation.status,
        paymentState: reservation.paymentState,
      },
    });
  }

  if (
    reservation.property.status !== "ACTIVE" ||
    reservation.property.isPublicBookable !== true
  ) {
    throw new GuestReservationModificationError({
      code: "PROPERTY_NOT_AVAILABLE_FOR_MODIFICATION",
      message: "This property is not accepting online reservation changes.",
      statusCode: 409,
    });
  }

  return reservation;
}

function serializeOptionalAmenities(
  amenities: Array<{
    id: string;
    name: string;
    description: string | null;
    feeType: unknown;
    amount: unknown;
  }>
) {
  return amenities.map((amenity) => ({
    id: amenity.id,
    name: amenity.name,
    description: amenity.description,
    feeType: amenity.feeType,
    amount: Number(amenity.amount ?? 0),
  }));
}

function serializePublicPricing(pricing: any) {
  return {
    currency: pricing.currency,
    nights: pricing.nights,
    nightlyRate: pricing.nightlyRate,
    nightlyRates: Array.isArray(pricing.nightlyRates)
      ? pricing.nightlyRates.map((night: any) => ({
          date: night.date,
          rate: night.rate,
        }))
      : [],
    nightlySubtotal: pricing.nightlySubtotal,
    cleaningFee: pricing.cleaningFee,
    amenities: pricing.amenities,
    chargedAmenities: pricing.chargedAmenities,
    amenitiesTotal: pricing.amenitiesTotal,
    taxableSubtotal: pricing.taxableSubtotal,
    taxes: pricing.taxes,
    taxesTotal: pricing.taxesTotal,
    totalAmount: pricing.totalAmount,
    totalAmountCents: pricing.totalAmountCents,
  };
}

function getCurrentGuestCounts(reservation: {
  adults: number | null;
  children: number | null;
  externalRaw: unknown;
  verificationGuestCount: number | null;
}) {
  if (
    Number.isInteger(reservation.adults) &&
    Number.isInteger(reservation.children) &&
    Number(reservation.adults) >= 1 &&
    Number(reservation.children) >= 0
  ) {
    const adults = Number(reservation.adults);
    const children = Number(reservation.children);

    return {
      adults,
      children,
      totalGuests: adults + children,
    };
  }

  const externalRaw = normalizeJsonObject(reservation.externalRaw);
  const metadata = normalizeJsonObject(externalRaw.metadata);
  const fallbackTotal = Math.max(
    1,
    parseGuestCount(reservation.verificationGuestCount, 1)
  );
  const adults = Math.max(1, parseGuestCount(metadata.adults, fallbackTotal));
  const children = parseGuestCount(metadata.children, 0);

  return {
    adults,
    children,
    totalGuests: adults + children,
  };
}

export function hasSecurePreCheckinGuestCountLock(reservation: {
  verificationGuestCount: number | null;
  verificationAcceptedRulesAt: Date | null;
  guestAgreementAcceptance: unknown;
  guestAgreementSignedAt: Date | null;
}) {
  return (
    reservation.verificationGuestCount !== null ||
    reservation.verificationAcceptedRulesAt !== null ||
    reservation.guestAgreementAcceptance !== null ||
    reservation.guestAgreementSignedAt !== null
  );
}

export function assertGuestCountChangeAllowed(input: {
  currentAdults: number;
  currentChildren: number;
  proposedAdults: number;
  proposedChildren: number;
  securePreCheckin: Parameters<
    typeof hasSecurePreCheckinGuestCountLock
  >[0];
}) {
  const guestsChanged =
    input.currentAdults !== input.proposedAdults ||
    input.currentChildren !== input.proposedChildren;

  if (
    guestsChanged &&
    hasSecurePreCheckinGuestCountLock(input.securePreCheckin)
  ) {
    throw new GuestReservationModificationError({
      code: "GUEST_COUNT_LOCKED_AFTER_SECURE_PRECHECKIN",
      message:
        "Guest count cannot be changed after secure pre-check-in has been completed.",
      statusCode: 409,
      details: {
        currentAdults: input.currentAdults,
        currentChildren: input.currentChildren,
      },
    });
  }

  return { guestsChanged };
}

function getNonRefundableScenarios(snapshotValue: unknown) {
  const snapshot = normalizeJsonObject(snapshotValue);

  if (!Array.isArray(snapshot.nonRefundableScenarios)) {
    return [];
  }

  return snapshot.nonRefundableScenarios
    .map((scenario) => String(scenario).trim())
    .filter(Boolean);
}

export function evaluateGuestReservationModificationReduction(input: {
  amountDifferenceCents: number;
  currentCheckIn: Date;
  currentCheckOut: Date;
  proposedCheckIn: Date;
  proposedCheckOut: Date;
  nonRefundableScenarios: string[];
}) {
  if (input.amountDifferenceCents >= 0) {
    return {
      outcome: "NOT_APPLICABLE",
      nonRefundableReasons: [] as string[],
      requiresHostApproval: false,
      refundableReductionAmountCents: 0,
    };
  }

  const nonRefundableReasons: string[] = [];

  if (
    input.proposedCheckIn.getTime() > input.currentCheckIn.getTime() &&
    input.nonRefundableScenarios.includes("DELAYED_ARRIVAL")
  ) {
    nonRefundableReasons.push("DELAYED_ARRIVAL");
  }

  if (
    input.proposedCheckOut.getTime() < input.currentCheckOut.getTime() &&
    input.nonRefundableScenarios.includes("REDUCED_NIGHTS")
  ) {
    nonRefundableReasons.push("REDUCED_NIGHTS");
  }

  if (nonRefundableReasons.length > 0) {
    return {
      outcome: "NO_REFUND_DUE",
      nonRefundableReasons,
      requiresHostApproval: false,
      refundableReductionAmountCents: 0,
    };
  }

  return {
    outcome: "HOST_APPROVAL_REQUIRED",
    nonRefundableReasons,
    requiresHostApproval: true,
    refundableReductionAmountCents: null,
  };
}

export async function getGuestReservationModificationOptions(input: {
  guestToken: string;
}) {
  const reservation = await getEligibleReservationByGuestToken(
    input.guestToken
  );
  const currentGuestCounts = getCurrentGuestCounts(reservation);
  const currentSelectedAmenityIds = normalizeSelectedAmenityIds(
    reservation.selectedAmenityIds
  );
  const currentTotalAmount = Number(reservation.totalAmount ?? 0);
  const guestCountLocked = hasSecurePreCheckinGuestCountLock(reservation);

  return {
    managementPhase: "PRE_STAY",
    modificationAllowed: true,
    constraints: {
      guestCountEditable: !guestCountLocked,
      guestCountLockReason: guestCountLocked
        ? "SECURE_PRECHECKIN_COMPLETED"
        : null,
    },
    reservation: {
      reservationNumber: reservation.reservationNumber,
      version: reservation.updatedAt,
      propertyName: reservation.property.name,
      status: reservation.status,
      paymentState: reservation.paymentState,
      currency: reservation.currency ?? "usd",
      current: {
        checkIn: reservation.checkIn,
        checkOut: reservation.checkOut,
        adults: currentGuestCounts.adults,
        children: currentGuestCounts.children,
        totalGuests: currentGuestCounts.totalGuests,
        selectedAmenityIds: currentSelectedAmenityIds,
        totalAmount: currentTotalAmount,
        totalAmountCents: Math.round(currentTotalAmount * 100),
      },
    },
    property: {
      timezone: reservation.property.timezone,
      checkInTime: reservation.property.checkInTime,
      checkOutTime: reservation.property.checkOutTime,
      maxGuests: reservation.property.maxGuests,
      minimumNights: reservation.property.minimumNights,
      maximumNights: reservation.property.maximumNights,
      optionalAmenities: serializeOptionalAmenities(
        reservation.property.amenities
      ),
    },
  };
}

export async function getGuestReservationModificationPreview(
  input: GuestReservationModificationPreviewInput
) {
  const guestToken = normalizeGuestToken(input.guestToken);

  if (!guestToken) {
    throw new GuestReservationModificationError({
      code: "MISSING_GUEST_TOKEN",
      message: "Missing guest reservation token.",
      statusCode: 400,
    });
  }

  if (
    !(input.checkIn instanceof Date) ||
    Number.isNaN(input.checkIn.getTime()) ||
    !(input.checkOut instanceof Date) ||
    Number.isNaN(input.checkOut.getTime()) ||
    input.checkOut <= input.checkIn
  ) {
    throw new GuestReservationModificationError({
      code: "INVALID_STAY_DATES",
      message: "Check-out must be after check-in.",
      statusCode: 400,
    });
  }

  if (
    !Number.isInteger(input.adults) ||
    !Number.isInteger(input.children) ||
    input.adults < 1 ||
    input.children < 0
  ) {
    throw new GuestReservationModificationError({
      code: "INVALID_GUEST_COUNT",
      message: "Invalid guest count.",
      statusCode: 400,
    });
  }

  const now = new Date();
  const reservation = await getEligibleReservationByGuestToken(
    guestToken,
    now
  );

  if (input.checkIn <= now) {
    throw new GuestReservationModificationError({
      code: "MODIFIED_CHECK_IN_MUST_BE_IN_FUTURE",
      message: "The modified check-in must be in the future.",
      statusCode: 400,
    });
  }

  const totalGuests = input.adults + input.children;

  if (
    reservation.property.maxGuests &&
    totalGuests > reservation.property.maxGuests
  ) {
    throw new GuestReservationModificationError({
      code: "MAXIMUM_GUESTS_EXCEEDED",
      message: `Maximum guests allowed is ${reservation.property.maxGuests}.`,
      statusCode: 400,
    });
  }

  const currentGuestCounts = getCurrentGuestCounts(reservation);
  const { guestsChanged } = assertGuestCountChangeAllowed({
    currentAdults: currentGuestCounts.adults,
    currentChildren: currentGuestCounts.children,
    proposedAdults: input.adults,
    proposedChildren: input.children,
    securePreCheckin: reservation,
  });

  const selectedAmenityIds = normalizeSelectedAmenityIds(
    input.selectedAmenityIds
  );
  const optionalAmenityIds = new Set(
    reservation.property.amenities.map((amenity) => amenity.id)
  );
  const invalidAmenityIds = selectedAmenityIds.filter(
    (amenityId) => !optionalAmenityIds.has(amenityId)
  );

  if (invalidAmenityIds.length > 0) {
    throw new GuestReservationModificationError({
      code: "INVALID_SELECTED_AMENITIES",
      message: "One or more selected amenities are not available.",
      statusCode: 400,
    });
  }

  const availability = await checkPropertyAvailability({
    propertyId: reservation.propertyId,
    checkIn: input.checkIn,
    checkOut: input.checkOut,
    excludeReservationId: reservation.id,
  });

  if (!availability.available) {
    throw new GuestReservationModificationError({
      code: "PROPERTY_NOT_AVAILABLE_FOR_SELECTED_DATES",
      message: "The property is not available for the selected dates.",
      statusCode: 409,
      details: {
        conflictType: availability.conflict?.type ?? null,
      },
    });
  }

  const proposedPricing = await calculateDirectBookingPricing({
    propertyId: reservation.propertyId,
    checkIn: input.checkIn,
    checkOut: input.checkOut,
    selectedAmenityIds,
    excludeReservationId: reservation.id,
  });

  if (
    proposedPricing.nights < (reservation.property.minimumNights ?? 1)
  ) {
    throw new GuestReservationModificationError({
      code: "MINIMUM_STAY_NOT_MET",
      message: `Minimum stay is ${reservation.property.minimumNights ?? 1} night(s).`,
      statusCode: 400,
    });
  }

  if (
    reservation.property.maximumNights &&
    proposedPricing.nights > reservation.property.maximumNights
  ) {
    throw new GuestReservationModificationError({
      code: "MAXIMUM_STAY_EXCEEDED",
      message: `Maximum stay is ${reservation.property.maximumNights} night(s).`,
      statusCode: 400,
    });
  }

  const currentTotalAmount = Number(reservation.totalAmount ?? 0);
  const currentTotalAmountCents = Math.round(currentTotalAmount * 100);

  if (
    !Number.isFinite(currentTotalAmountCents) ||
    currentTotalAmountCents <= 0
  ) {
    throw new GuestReservationModificationError({
      code: "CURRENT_RESERVATION_TOTAL_INVALID",
      message: "The current reservation total is unavailable.",
      statusCode: 409,
    });
  }

  const currentSelectedAmenityIds = normalizeSelectedAmenityIds(
    reservation.selectedAmenityIds
  );
  const datesChanged =
    reservation.checkIn.getTime() !== input.checkIn.getTime() ||
    reservation.checkOut.getTime() !== input.checkOut.getTime();
  const amenitiesChanged = !sameStringSet(
    currentSelectedAmenityIds,
    selectedAmenityIds
  );
  const amountDifferenceCents =
    proposedPricing.totalAmountCents - currentTotalAmountCents;
  const nonRefundableScenarios = getNonRefundableScenarios(
    reservation.cancellationPolicySnapshot
  );
  const reductionPolicy = evaluateGuestReservationModificationReduction({
    amountDifferenceCents,
    currentCheckIn: reservation.checkIn,
    currentCheckOut: reservation.checkOut,
    proposedCheckIn: input.checkIn,
    proposedCheckOut: input.checkOut,
    nonRefundableScenarios,
  });

  const financialAction =
    amountDifferenceCents > 0
      ? "ADDITIONAL_PAYMENT_REQUIRED"
      : amountDifferenceCents < 0
        ? reductionPolicy.outcome === "NO_REFUND_DUE"
          ? "NO_REFUND_DUE_CONFIRMATION_REQUIRED"
          : "REDUCTION_REVIEW_REQUIRED"
        : "NO_PAYMENT_REQUIRED";

  return {
    managementPhase: "PRE_STAY",
    modificationAllowed: true,
    reservation: {
      reservationNumber: reservation.reservationNumber,
      version: reservation.updatedAt,
      propertyName: reservation.property.name,
      status: reservation.status,
      paymentState: reservation.paymentState,
      currency: reservation.currency ?? "usd",
      current: {
        checkIn: reservation.checkIn,
        checkOut: reservation.checkOut,
        adults: currentGuestCounts.adults,
        children: currentGuestCounts.children,
        totalGuests: currentGuestCounts.totalGuests,
        selectedAmenityIds: currentSelectedAmenityIds,
        totalAmount: currentTotalAmount,
        totalAmountCents: currentTotalAmountCents,
      },
      proposed: {
        checkIn: input.checkIn,
        checkOut: input.checkOut,
        adults: input.adults,
        children: input.children,
        totalGuests,
        selectedAmenityIds,
      },
    },
    property: {
      timezone: reservation.property.timezone,
      checkInTime: reservation.property.checkInTime,
      checkOutTime: reservation.property.checkOutTime,
      maxGuests: reservation.property.maxGuests,
      minimumNights: reservation.property.minimumNights,
      maximumNights: reservation.property.maximumNights,
      optionalAmenities: serializeOptionalAmenities(
        reservation.property.amenities
      ),
    },
    changes: {
      datesChanged,
      guestsChanged,
      amenitiesChanged,
      hasChanges: datesChanged || guestsChanged || amenitiesChanged,
      requiresSecurePreCheckinRefresh: guestsChanged,
    },
    pricing: {
      currentTotalAmount,
      currentTotalAmountCents,
      proposed: serializePublicPricing(proposedPricing),
      amountDifference: amountDifferenceCents / 100,
      amountDifferenceCents,
      additionalPaymentAmountCents: Math.max(0, amountDifferenceCents),
      potentialReductionAmountCents: Math.max(0, -amountDifferenceCents),
      financialAction,
      reductionPolicy,
    },
  };
}

export async function confirmGuestReservationModification(
  input: GuestReservationModificationConfirmInput
) {
  const guestToken = normalizeGuestToken(input.guestToken);
  const clientRequestId = normalizeClientRequestId(input.clientRequestId);
  const selectedAmenityIds = normalizeSelectedAmenityIds(
    input.selectedAmenityIds
  );
  const acceptNoRefundReduction = input.acceptNoRefundReduction === true;

  if (!guestToken) {
    throw new GuestReservationModificationError({
      code: "MISSING_GUEST_TOKEN",
      message: "Missing guest reservation token.",
      statusCode: 400,
    });
  }

  const requestFingerprint =
    buildGuestReservationModificationRequestFingerprint({
      checkIn: input.checkIn,
      checkOut: input.checkOut,
      adults: input.adults,
      children: input.children,
      selectedAmenityIds,
      acceptNoRefundReduction,
    });
  const now = new Date();
  const existingReplay = await prisma.reservationModification.findFirst({
    where: {
      clientRequestId,
      reservation: {
        guestToken,
        OR: [
          { guestTokenExpiresAt: null },
          { guestTokenExpiresAt: { gt: now } },
        ],
      },
    },
  });

  if (existingReplay) {
    if (existingReplay.requestFingerprint !== requestFingerprint) {
      throw new GuestReservationModificationError({
        code: "CLIENT_REQUEST_ID_REUSED",
        message: "This client request ID was already used for another change.",
        statusCode: 409,
      });
    }

    return {
      ok: true,
      idempotentReplay: true,
      modification: serializeReservationModification(existingReplay),
    };
  }

  const preview = await getGuestReservationModificationPreview({
    guestToken,
    checkIn: input.checkIn,
    checkOut: input.checkOut,
    adults: input.adults,
    children: input.children,
    selectedAmenityIds,
  });

  if (!preview.changes.hasChanges) {
    throw new GuestReservationModificationError({
      code: "RESERVATION_MODIFICATION_HAS_NO_CHANGES",
      message: "The proposed reservation is identical to the current reservation.",
      statusCode: 400,
    });
  }

  const financialAction = preview.pricing
    .financialAction as ReservationModificationFinancialAction;

  if (
    financialAction ===
      ReservationModificationFinancialAction.NO_REFUND_DUE_CONFIRMATION_REQUIRED &&
    !acceptNoRefundReduction
  ) {
    throw new GuestReservationModificationError({
      code: "NO_REFUND_REDUCTION_CONFIRMATION_REQUIRED",
      message: "Explicit confirmation of the non-refundable reduction is required.",
      statusCode: 400,
      details: preview.pricing.reductionPolicy,
    });
  }

  const baseReservation = await getEligibleReservationByGuestToken(
    guestToken,
    now
  );

  if (
    baseReservation.updatedAt.getTime() !==
    preview.reservation.version.getTime()
  ) {
    throw new GuestReservationModificationError({
      code: "RESERVATION_CHANGED_RETRY_PREVIEW",
      message: "The reservation changed while the modification was being prepared.",
      statusCode: 409,
    });
  }

  const initialStatus = getGuestReservationModificationInitialStatus(
    financialAction
  );
  const additionalChargeAmountCents = Math.max(
    0,
    preview.pricing.amountDifferenceCents
  );
  const incrementalSplit =
    additionalChargeAmountCents > 0
      ? calculateDirectBookingModificationConnectFee({
          additionalChargeAmountCents,
          platformFeePercent: getModificationPlatformFeePercent(),
        })
      : null;
  const confirmedAt = new Date();
  const checkoutExpiresAt =
    initialStatus === ReservationModificationStatus.AWAITING_PAYMENT
      ? new Date(confirmedAt.getTime() + 60 * 60 * 1000)
      : null;
  const activeStatuses = [
    ReservationModificationStatus.AWAITING_PAYMENT,
    ReservationModificationStatus.PAYMENT_PROCESSING,
    ReservationModificationStatus.HOST_APPROVAL_REQUIRED,
    ReservationModificationStatus.APPLYING,
  ];

  const modification = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`
      SELECT "id"
      FROM "Reservation"
      WHERE "id" = ${baseReservation.id}
      FOR UPDATE
    `;

    const currentReservation = await tx.reservation.findUnique({
      where: { id: baseReservation.id },
      select: {
        id: true,
        updatedAt: true,
        status: true,
        paymentState: true,
        checkIn: true,
      },
    });

    if (
      !currentReservation ||
      currentReservation.updatedAt.getTime() !==
        baseReservation.updatedAt.getTime() ||
      currentReservation.status !== ReservationStatus.ACTIVE ||
      currentReservation.paymentState !== PaymentState.PAID ||
      currentReservation.checkIn <= confirmedAt
    ) {
      throw new GuestReservationModificationError({
        code: "RESERVATION_CHANGED_RETRY_PREVIEW",
        message: "The reservation changed before the modification was saved.",
        statusCode: 409,
      });
    }

    const replayInsideLock = await tx.reservationModification.findUnique({
      where: {
        reservationId_clientRequestId: {
          reservationId: baseReservation.id,
          clientRequestId,
        },
      },
    });

    if (replayInsideLock) {
      if (replayInsideLock.requestFingerprint !== requestFingerprint) {
        throw new GuestReservationModificationError({
          code: "CLIENT_REQUEST_ID_REUSED",
          message: "This client request ID was already used for another change.",
          statusCode: 409,
        });
      }

      return {
        record: replayInsideLock,
        idempotentReplay: true,
      };
    }

    await tx.reservationModification.updateMany({
      where: {
        reservationId: baseReservation.id,
        status: ReservationModificationStatus.AWAITING_PAYMENT,
        checkoutExpiresAt: { lte: confirmedAt },
      },
      data: {
        status: ReservationModificationStatus.EXPIRED,
        expiredAt: confirmedAt,
      },
    });

    const activeModification = await tx.reservationModification.findFirst({
      where: {
        reservationId: baseReservation.id,
        status: { in: activeStatuses },
      },
      select: {
        id: true,
        status: true,
      },
    });

    if (activeModification) {
      throw new GuestReservationModificationError({
        code: "ACTIVE_RESERVATION_MODIFICATION_EXISTS",
        message: "Another reservation modification is already in progress.",
        statusCode: 409,
        details: activeModification,
      });
    }

    const currentGuestCounts = getCurrentGuestCounts(baseReservation);
    const currentSelectedAmenityIds = normalizeSelectedAmenityIds(
      baseReservation.selectedAmenityIds
    );

    const createdModification = await tx.reservationModification.create({
      data: {
        reservationId: baseReservation.id,
        clientRequestId,
        requestFingerprint,
        status: initialStatus,
        financialAction,
        baseReservationUpdatedAt: baseReservation.updatedAt,
        currentCheckIn: baseReservation.checkIn,
        currentCheckOut: baseReservation.checkOut,
        proposedCheckIn: input.checkIn,
        proposedCheckOut: input.checkOut,
        currentAdults: currentGuestCounts.adults,
        currentChildren: currentGuestCounts.children,
        proposedAdults: input.adults,
        proposedChildren: input.children,
        currentSelectedAmenityIds,
        proposedSelectedAmenityIds: selectedAmenityIds,
        currentPricing: (baseReservation.pricingBreakdown ?? {
          totalAmount: preview.pricing.currentTotalAmount,
          totalAmountCents: preview.pricing.currentTotalAmountCents,
        }) as any,
        proposedPricing: preview.pricing.proposed as any,
        reductionPolicy: preview.pricing.reductionPolicy as any,
        guestConfirmation: {
          confirmed: true,
          confirmedAt: confirmedAt.toISOString(),
          source: "GUEST_MANAGE_RESERVATION",
          acceptedNoRefundReduction:
            financialAction ===
            ReservationModificationFinancialAction.NO_REFUND_DUE_CONFIRMATION_REQUIRED,
        },
        currentTotalAmount: preview.pricing.currentTotalAmount,
        proposedTotalAmount: preview.pricing.proposed.totalAmount,
        amountDifference: preview.pricing.amountDifference,
        additionalChargeAmount: additionalChargeAmountCents / 100,
        additionalPlatformFeeAmount:
          (incrementalSplit?.additionalPlatformFeeAmountCents ?? 0) / 100,
        additionalHostPayoutAmount:
          (incrementalSplit?.additionalHostPayoutAmountCents ?? 0) / 100,
        currency: preview.reservation.currency,
        checkoutExpiresAt,
      },
    });

    return {
      record: createdModification,
      idempotentReplay: false,
    };
  });

  return {
    ok: true,
    idempotentReplay: modification.idempotentReplay,
    modification: serializeReservationModification(modification.record),
  };
}
