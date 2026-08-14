import {
  PaymentState,
  Prisma,
  PrismaClient,
  ReservationModificationFinancialAction,
  ReservationModificationStatus,
  ReservationStatus,
} from "@prisma/client";
import { formatInTimeZone } from "date-fns-tz";

import { persistChannexAriReservationIntent } from "../pms/outbound/channex-ari-reservation-producer.service";
import {
  assertGuestCountChangeAllowed,
  GuestReservationModificationError,
} from "./guest-reservation-modification.service";
import { reconcileReservation } from "./reservation.reconcile.service";

const prisma = new PrismaClient();
const GUEST_TOKEN_POST_CHECKOUT_MS = 48 * 60 * 60 * 1000;

type MoneyValue = Prisma.Decimal | number | string | null;

type ApplyPlanInput = {
  now: Date;
  modification: {
    status: ReservationModificationStatus;
    financialAction: ReservationModificationFinancialAction;
    currentCheckIn: Date;
    currentCheckOut: Date;
    proposedCheckIn: Date;
    proposedCheckOut: Date;
    currentAdults: number;
    currentChildren: number;
    proposedAdults: number;
    proposedChildren: number;
    currentSelectedAmenityIds: string[];
    proposedSelectedAmenityIds: string[];
    currentTotalAmount: MoneyValue;
    proposedTotalAmount: MoneyValue;
    amountDifference: MoneyValue;
    additionalChargeAmount: MoneyValue;
    additionalPlatformFeeAmount: MoneyValue;
    additionalHostPayoutAmount: MoneyValue;
    currency: string;
    guestConfirmation: unknown;
    stripeConnectedAccountId: string | null;
    stripeCheckoutSessionId: string | null;
    stripePaymentIntentId: string | null;
    stripeChargeId: string | null;
    stripeTransferId: string | null;
    stripeApplicationFeeId: string | null;
    stripePaymentStatus: string | null;
  };
  reservation: {
    status: ReservationStatus;
    paymentState: PaymentState;
    checkIn: Date;
    checkOut: Date;
    adults: number;
    children: number;
    selectedAmenityIds: string[];
    totalAmount: MoneyValue;
    amountCollected: MoneyValue;
    platformFeeAmount: MoneyValue;
    hostPayoutAmount: MoneyValue;
    currency: string | null;
    stripeConnectedAccountId: string | null;
    verificationGuestCount: number | null;
    verificationAcceptedRulesAt: Date | null;
    guestAgreementAcceptance: unknown;
    guestAgreementSignedAt: Date | null;
  };
};

export type GuestReservationModificationApplyPlan = {
  datesChanged: boolean;
  guestsChanged: boolean;
  amenitiesChanged: boolean;
  proposedTotalAmount: number;
  proposedPricingAmountDifference: number;
  nextAmountCollected: number;
  nextPlatformFeeAmount: number;
  nextHostPayoutAmount: number;
  guestTokenExpiresAt: Date;
};

function applyError(input: {
  code: string;
  message: string;
  details?: unknown;
}) {
  return new GuestReservationModificationError({
    code: input.code,
    message: input.message,
    statusCode: 409,
    details: input.details,
  });
}

function normalizeId(value: unknown, code: string) {
  const normalized = String(value ?? "").trim();

  if (!normalized) {
    throw new GuestReservationModificationError({
      code,
      message: "A reservation modification ID is required.",
      statusCode: 400,
    });
  }
  return normalized;
}

function normalizeStringSet(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  return Array.from(
    new Set(value.map((item) => String(item).trim()).filter(Boolean))
  ).sort();
}

function sameStringSet(left: unknown, right: unknown) {
  const normalizedLeft = normalizeStringSet(left);
  const normalizedRight = normalizeStringSet(right);

  return (
    normalizedLeft.length === normalizedRight.length &&
    normalizedLeft.every(
      (value, index) => value === normalizedRight[index]
    )
  );
}

function readJsonObject(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function toCents(value: MoneyValue, code: string) {
  const amount = Number(value);
  const cents = Math.round(amount * 100);

  if (!Number.isFinite(amount) || !Number.isInteger(cents) || cents < 0) {
    throw applyError({
      code,
      message: "Reservation modification financial data is invalid.",
    });
  }

  return cents;
}

function assertValidDate(value: Date, code: string) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    throw applyError({
      code,
      message: "Reservation modification dates are invalid.",
    });
  }

  return date;
}

function assertCanonicalReservationSnapshot(
  input: ApplyPlanInput,
  currentTotalAmountCents: number
) {
  const modification = input.modification;
  const reservation = input.reservation;

  const snapshotMatches =
    reservation.checkIn.getTime() === modification.currentCheckIn.getTime() &&
    reservation.checkOut.getTime() === modification.currentCheckOut.getTime() &&
    reservation.adults === modification.currentAdults &&
    reservation.children === modification.currentChildren &&
    sameStringSet(
      reservation.selectedAmenityIds,
      modification.currentSelectedAmenityIds
    ) &&
    toCents(
      reservation.totalAmount,
      "RESERVATION_CURRENT_TOTAL_INVALID"
    ) === currentTotalAmountCents &&
    String(reservation.currency ?? "").toLowerCase() ===
      modification.currency.toLowerCase();

  if (!snapshotMatches) {
    throw applyError({
      code: "RESERVATION_CHANGED_BEFORE_MODIFICATION_APPLY",
      message:
        "The reservation changed before this modification could be applied.",
    });
  }
}

function assertFinancialContract(input: {
  modification: ApplyPlanInput["modification"];
  reservation: ApplyPlanInput["reservation"];
  amountDifferenceCents: number;
  additionalChargeAmountCents: number;
  additionalPlatformFeeAmountCents: number;
  additionalHostPayoutAmountCents: number;
}) {
  const action = input.modification.financialAction;
  const guestConfirmation = readJsonObject(
    input.modification.guestConfirmation
  );
  const additionalSplitMatches =
    input.additionalPlatformFeeAmountCents +
      input.additionalHostPayoutAmountCents ===
    input.additionalChargeAmountCents;

  if (!additionalSplitMatches) {
    throw applyError({
      code: "RESERVATION_MODIFICATION_FINANCIAL_SPLIT_INVALID",
      message: "The additional payment split is invalid.",
    });
  }

  if (guestConfirmation.confirmed !== true) {
    throw applyError({
      code: "RESERVATION_MODIFICATION_GUEST_CONFIRMATION_MISSING",
      message: "The guest confirmation for this modification is missing.",
    });
  }

  if (
    action ===
    ReservationModificationFinancialAction.ADDITIONAL_PAYMENT_REQUIRED
  ) {
    const paymentEvidenceComplete =
      input.amountDifferenceCents > 0 &&
      input.additionalChargeAmountCents === input.amountDifferenceCents &&
      Boolean(input.modification.stripeCheckoutSessionId) &&
      Boolean(input.modification.stripePaymentIntentId) &&
      Boolean(input.modification.stripeChargeId) &&
      Boolean(input.modification.stripeTransferId) &&
      (input.additionalPlatformFeeAmountCents === 0 ||
        Boolean(input.modification.stripeApplicationFeeId)) &&
      input.modification.stripePaymentStatus === "paid" &&
      Boolean(input.modification.stripeConnectedAccountId) &&
      input.modification.stripeConnectedAccountId ===
        input.reservation.stripeConnectedAccountId;

    if (!paymentEvidenceComplete) {
      throw applyError({
        code: "RESERVATION_MODIFICATION_PAYMENT_EVIDENCE_INCOMPLETE",
        message:
          "The additional payment is not ready to be applied to the reservation.",
      });
    }

    return;
  }

  if (
    input.additionalChargeAmountCents !== 0 ||
    input.additionalPlatformFeeAmountCents !== 0 ||
    input.additionalHostPayoutAmountCents !== 0
  ) {
    throw applyError({
      code: "RESERVATION_MODIFICATION_UNEXPECTED_ADDITIONAL_PAYMENT",
      message: "This modification must not contain an additional payment.",
    });
  }

  const actionMatchesDifference =
    (action === ReservationModificationFinancialAction.NO_PAYMENT_REQUIRED &&
      input.amountDifferenceCents === 0) ||
    (action ===
      ReservationModificationFinancialAction.NO_REFUND_DUE_CONFIRMATION_REQUIRED &&
      input.amountDifferenceCents < 0) ||
    (action ===
      ReservationModificationFinancialAction.REDUCTION_REVIEW_REQUIRED &&
      input.amountDifferenceCents < 0);

  if (!actionMatchesDifference) {
    throw applyError({
      code: "RESERVATION_MODIFICATION_FINANCIAL_ACTION_INVALID",
      message:
        "The reservation modification financial action is inconsistent.",
    });
  }

  if (
    action ===
      ReservationModificationFinancialAction.NO_REFUND_DUE_CONFIRMATION_REQUIRED &&
    guestConfirmation.acceptedNoRefundReduction !== true
  ) {
    throw applyError({
      code: "NO_REFUND_REDUCTION_CONFIRMATION_REQUIRED",
      message:
        "Explicit confirmation of the non-refundable reduction is required.",
    });
  }
}

export function buildGuestReservationModificationApplyPlan(
  input: ApplyPlanInput
): GuestReservationModificationApplyPlan {
  if (input.modification.status !== ReservationModificationStatus.APPLYING) {
    throw applyError({
      code: "RESERVATION_MODIFICATION_NOT_APPLYING",
      message: "This reservation modification is not ready to be applied.",
      details: { status: input.modification.status },
    });
  }

  if (
    input.reservation.status !== ReservationStatus.ACTIVE ||
    input.reservation.paymentState !== PaymentState.PAID ||
    input.reservation.checkIn.getTime() <= input.now.getTime()
  ) {
    throw applyError({
      code: "RESERVATION_NOT_ELIGIBLE_FOR_MODIFICATION_APPLY",
      message: "This reservation can no longer be modified online.",
    });
  }

  const proposedCheckIn = assertValidDate(
    input.modification.proposedCheckIn,
    "RESERVATION_MODIFICATION_PROPOSED_CHECK_IN_INVALID"
  );
  const proposedCheckOut = assertValidDate(
    input.modification.proposedCheckOut,
    "RESERVATION_MODIFICATION_PROPOSED_CHECK_OUT_INVALID"
  );

  if (
    proposedCheckOut <= proposedCheckIn ||
    proposedCheckIn.getTime() <= input.now.getTime()
  ) {
    throw applyError({
      code: "RESERVATION_MODIFICATION_PROPOSED_STAY_INVALID",
      message: "The proposed stay can no longer be applied.",
    });
  }

  const currentTotalAmountCents = toCents(
    input.modification.currentTotalAmount,
    "RESERVATION_MODIFICATION_CURRENT_TOTAL_INVALID"
  );
  const proposedTotalAmountCents = toCents(
    input.modification.proposedTotalAmount,
    "RESERVATION_MODIFICATION_PROPOSED_TOTAL_INVALID"
  );
  const storedAmountDifferenceCents = Math.round(
    Number(input.modification.amountDifference) * 100
  );
  const amountDifferenceCents =
    proposedTotalAmountCents - currentTotalAmountCents;

  if (currentTotalAmountCents <= 0 || proposedTotalAmountCents <= 0) {
    throw applyError({
      code: "RESERVATION_MODIFICATION_TOTAL_INVALID",
      message: "Reservation modification totals must be positive.",
    });
  }

  if (
    !Number.isInteger(storedAmountDifferenceCents) ||
    storedAmountDifferenceCents !== amountDifferenceCents
  ) {
    throw applyError({
      code: "RESERVATION_MODIFICATION_AMOUNT_DIFFERENCE_INVALID",
      message: "The stored reservation price difference is invalid.",
    });
  }

  assertCanonicalReservationSnapshot(input, currentTotalAmountCents);

  const additionalChargeAmountCents = toCents(
    input.modification.additionalChargeAmount,
    "RESERVATION_MODIFICATION_ADDITIONAL_CHARGE_INVALID"
  );
  const additionalPlatformFeeAmountCents = toCents(
    input.modification.additionalPlatformFeeAmount,
    "RESERVATION_MODIFICATION_ADDITIONAL_PLATFORM_FEE_INVALID"
  );
  const additionalHostPayoutAmountCents = toCents(
    input.modification.additionalHostPayoutAmount,
    "RESERVATION_MODIFICATION_ADDITIONAL_HOST_PAYOUT_INVALID"
  );

  assertFinancialContract({
    modification: input.modification,
    reservation: input.reservation,
    amountDifferenceCents,
    additionalChargeAmountCents,
    additionalPlatformFeeAmountCents,
    additionalHostPayoutAmountCents,
  });

  const { guestsChanged } = assertGuestCountChangeAllowed({
    currentAdults: input.modification.currentAdults,
    currentChildren: input.modification.currentChildren,
    proposedAdults: input.modification.proposedAdults,
    proposedChildren: input.modification.proposedChildren,
    securePreCheckin: input.reservation,
  });
  const datesChanged =
    input.modification.currentCheckIn.getTime() !== proposedCheckIn.getTime() ||
    input.modification.currentCheckOut.getTime() !== proposedCheckOut.getTime();
  const amenitiesChanged = !sameStringSet(
    input.modification.currentSelectedAmenityIds,
    input.modification.proposedSelectedAmenityIds
  );
  const amountCollectedCents = toCents(
    input.reservation.amountCollected,
    "RESERVATION_AMOUNT_COLLECTED_INVALID"
  );
  const platformFeeAmountCents = toCents(
    input.reservation.platformFeeAmount ?? 0,
    "RESERVATION_PLATFORM_FEE_INVALID"
  );
  const hostPayoutAmountCents = toCents(
    input.reservation.hostPayoutAmount ?? 0,
    "RESERVATION_HOST_PAYOUT_INVALID"
  );

  return {
    datesChanged,
    guestsChanged,
    amenitiesChanged,
    proposedTotalAmount: proposedTotalAmountCents / 100,
    proposedPricingAmountDifference: amountDifferenceCents / 100,
    nextAmountCollected:
      (amountCollectedCents + additionalChargeAmountCents) / 100,
    nextPlatformFeeAmount:
      (platformFeeAmountCents + additionalPlatformFeeAmountCents) / 100,
    nextHostPayoutAmount:
      (hostPayoutAmountCents + additionalHostPayoutAmountCents) / 100,
    guestTokenExpiresAt: new Date(
      proposedCheckOut.getTime() + GUEST_TOKEN_POST_CHECKOUT_MS
    ),
  };
}

async function assertProposedDatesAvailable(input: {
  tx: Prisma.TransactionClient;
  modificationId: string;
  reservationId: string;
  propertyId: string;
  checkIn: Date;
  checkOut: Date;
  now: Date;
}) {
  const reservationConflict = await input.tx.reservation.findFirst({
    where: {
      id: { not: input.reservationId },
      propertyId: input.propertyId,
      status: ReservationStatus.ACTIVE,
      checkIn: { lt: input.checkOut },
      checkOut: { gt: input.checkIn },
    },
    select: { id: true },
  });

  if (reservationConflict) {
    throw applyError({
      code: "PROPERTY_NOT_AVAILABLE_FOR_MODIFICATION_APPLY",
      message: "The property is no longer available for the selected dates.",
      details: { conflictType: "RESERVATION" },
    });
  }

  const modificationConflict =
    await input.tx.reservationModification.findFirst({
      where: {
        id: { not: input.modificationId },
        reservation: { propertyId: input.propertyId },
        proposedCheckIn: { lt: input.checkOut },
        proposedCheckOut: { gt: input.checkIn },
        OR: [
          { status: ReservationModificationStatus.PAYMENT_PROCESSING },
          { status: ReservationModificationStatus.APPLYING },
          {
            status: ReservationModificationStatus.AWAITING_PAYMENT,
            checkoutExpiresAt: { gt: input.now },
          },
        ],
      },
      select: { id: true },
    });

  if (modificationConflict) {
    throw applyError({
      code: "PROPERTY_NOT_AVAILABLE_FOR_MODIFICATION_APPLY",
      message: "The property is reserved by another pending modification.",
      details: { conflictType: "RESERVATION_MODIFICATION_HOLD" },
    });
  }

  const blockedDateConflict = await input.tx.propertyBlockedDate.findFirst({
    where: {
      propertyId: input.propertyId,
      startDate: { lt: input.checkOut },
      endDate: { gt: input.checkIn },
    },
    select: { id: true },
  });

  if (blockedDateConflict) {
    throw applyError({
      code: "PROPERTY_NOT_AVAILABLE_FOR_MODIFICATION_APPLY",
      message: "The selected dates are blocked for this property.",
      details: { conflictType: "BLOCKED_DATE" },
    });
  }
}

function serializeAppliedResult(input: {
  modification: {
    id: string;
    status: ReservationModificationStatus;
    appliedAt: Date | null;
  };
  reservation: {
    id: string;
    checkIn: Date;
    checkOut: Date;
    adults: number;
    children: number;
    selectedAmenityIds: string[];
    totalAmount: MoneyValue;
    amountCollected: MoneyValue;
    currency: string | null;
  };
  datesChanged: boolean;
  idempotentReplay: boolean;
  ariIntentCreated: boolean;
}) {
  return {
    ok: true,
    idempotentReplay: input.idempotentReplay,
    datesChanged: input.datesChanged,
    ariIntentCreated: input.ariIntentCreated,
    modification: {
      id: input.modification.id,
      status: input.modification.status,
      appliedAt: input.modification.appliedAt,
    },
    reservation: {
      id: input.reservation.id,
      checkIn: input.reservation.checkIn,
      checkOut: input.reservation.checkOut,
      adults: input.reservation.adults,
      children: input.reservation.children,
      selectedAmenityIds: input.reservation.selectedAmenityIds,
      totalAmount: Number(input.reservation.totalAmount),
      amountCollected: Number(input.reservation.amountCollected),
      currency: input.reservation.currency,
    },
  };
}

export async function applyGuestReservationModification(input: {
  modificationId: string;
}) {
  const modificationId = normalizeId(
    input.modificationId,
    "RESERVATION_MODIFICATION_ID_REQUIRED"
  );
  const locator = await prisma.reservationModification.findUnique({
    where: { id: modificationId },
    select: { reservationId: true },
  });

  if (!locator) {
    throw new GuestReservationModificationError({
      code: "RESERVATION_MODIFICATION_NOT_FOUND",
      message: "Reservation modification not found.",
      statusCode: 404,
    });
  }

  const now = new Date();

  try {
    const result = await prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`
          SELECT "id"
          FROM "Reservation"
          WHERE "id" = ${locator.reservationId}
          FOR UPDATE
        `;
        await tx.$queryRaw`
          SELECT "id"
          FROM "ReservationModification"
          WHERE "id" = ${modificationId}
          FOR UPDATE
        `;

        const modification = await tx.reservationModification.findUnique({
          where: { id: modificationId },
          include: {
            reservation: {
              include: {
                property: {
                  select: {
                    organizationId: true,
                    timezone: true,
                    distributionEnabled: true,
                    distributionStatus: true,
                  },
                },
              },
            },
          },
        });

        if (
          !modification ||
          modification.reservationId !== locator.reservationId
        ) {
          throw applyError({
            code: "RESERVATION_MODIFICATION_LOCK_CONFLICT",
            message: "The reservation modification changed while being applied.",
          });
        }

        const datesChanged =
          modification.currentCheckIn.getTime() !==
            modification.proposedCheckIn.getTime() ||
          modification.currentCheckOut.getTime() !==
            modification.proposedCheckOut.getTime();

        if (modification.status === ReservationModificationStatus.APPLIED) {
          return {
            modification,
            reservation: modification.reservation,
            datesChanged,
            idempotentReplay: true,
            ariIntentCreated: false,
          };
        }

        const plan = buildGuestReservationModificationApplyPlan({
          now,
          modification,
          reservation: modification.reservation,
        });

        if (plan.datesChanged) {
          await assertProposedDatesAvailable({
            tx,
            modificationId: modification.id,
            reservationId: modification.reservation.id,
            propertyId: modification.reservation.propertyId,
            checkIn: modification.proposedCheckIn,
            checkOut: modification.proposedCheckOut,
            now,
          });
        }

        const hasAdditionalPayment =
          Number(modification.additionalChargeAmount) > 0;
        const persistedReservation = await tx.reservation.update({
          where: { id: modification.reservation.id },
          data: {
            checkIn: modification.proposedCheckIn,
            checkOut: modification.proposedCheckOut,
            adults: modification.proposedAdults,
            children: modification.proposedChildren,
            selectedAmenityIds: modification.proposedSelectedAmenityIds,
            totalAmount: plan.proposedTotalAmount,
            pricingBreakdown:
              modification.proposedPricing as Prisma.InputJsonValue,
            guestTokenExpiresAt: plan.guestTokenExpiresAt,
            ...(plan.datesChanged
              ? {
                  lastReconciledCheckIn:
                    modification.reservation.lastReconciledCheckIn ??
                    modification.currentCheckIn,
                  lastReconciledCheckOut:
                    modification.reservation.lastReconciledCheckOut ??
                    modification.currentCheckOut,
                  lastHardwareSyncAt: null,
                }
              : {}),
            ...(hasAdditionalPayment
              ? {
                  amountCollected: plan.nextAmountCollected,
                  platformFeeAmount: plan.nextPlatformFeeAmount,
                  hostPayoutAmount: plan.nextHostPayoutAmount,
                  hostPayoutLastSyncedAt: now,
                }
              : {}),
          },
        });

        let ariIntentCreated = false;
        const property = modification.reservation.property;

        if (
          plan.datesChanged &&
          property.distributionEnabled === true &&
          property.distributionStatus === "ACTIVE"
        ) {
          const propertyTimezone =
            property.timezone ?? "America/Puerto_Rico";
          const ariIntent = await persistChannexAriReservationIntent({
            db: tx,
            organizationId: property.organizationId,
            propertyId: persistedReservation.propertyId,
            reservationId: persistedReservation.id,
            previous: {
              checkIn: modification.currentCheckIn,
              checkOut: modification.currentCheckOut,
              status: "ACTIVE",
            },
            current: {
              checkIn: persistedReservation.checkIn,
              checkOut: persistedReservation.checkOut,
              status: "ACTIVE",
            },
            propertyTimezone,
            todayDateKey: formatInTimeZone(
              now,
              propertyTimezone,
              "yyyy-MM-dd"
            ),
            now,
          });

          ariIntentCreated = Boolean(ariIntent);
        }

        const appliedModification =
          await tx.reservationModification.update({
            where: { id: modification.id },
            data: {
              status: ReservationModificationStatus.APPLIED,
              appliedAt: now,
              failureCode: null,
              failureMessage: null,
              failureDetails: Prisma.DbNull,
            },
          });

        return {
          modification: appliedModification,
          reservation: persistedReservation,
          datesChanged: plan.datesChanged,
          idempotentReplay: false,
          ariIntentCreated,
        };
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      }
    );

    if (result.datesChanged) {
      await reconcileReservation(result.reservation.id);
    }

    return serializeAppliedResult(result);
  } catch (error: any) {
    await prisma.reservationModification
      .updateMany({
        where: {
          id: modificationId,
          status: ReservationModificationStatus.APPLYING,
        },
        data: {
          failureCode:
            error instanceof GuestReservationModificationError
              ? error.code
              : "RESERVATION_MODIFICATION_APPLY_FAILED",
          failureMessage:
            String(error?.message ?? "Reservation modification apply failed.").slice(
              0,
              500
            ),
          failureDetails: {
            retryable:
              !(error instanceof GuestReservationModificationError) ||
              error.statusCode >= 500,
          },
        },
      })
      .catch(() => {});

    throw error;
  }
}
