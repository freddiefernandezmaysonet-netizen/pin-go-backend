import Stripe from "stripe";
import {
  Prisma,
  PrismaClient,
  ReservationModificationFinancialAction,
  ReservationModificationStatus,
} from "@prisma/client";

import stripe from "../billing/stripe";
import { applyGuestReservationModification } from "./guest-reservation-modification-apply.service";
import { GuestReservationModificationError } from "./guest-reservation-modification.service";

const prisma = new PrismaClient();
const MODIFICATION_PAYMENT_FLOW =
  "direct_booking_reservation_modification";

type MoneyValue = Prisma.Decimal | number | string;

type ModificationPaymentSnapshot = {
  id: string;
  reservationId: string;
  financialAction: ReservationModificationFinancialAction;
  currency: string;
  additionalChargeAmount: MoneyValue;
  additionalPlatformFeeAmount: MoneyValue;
  additionalHostPayoutAmount: MoneyValue;
  stripeConnectedAccountId: string | null;
  stripeCheckoutSessionId: string | null;
  reservation: {
    id: string;
    propertyId: string;
    stripeConnectedAccountId: string | null;
  };
};

export type GuestReservationModificationPaidCheckoutContract = {
  modificationId: string;
  reservationId: string;
  propertyId: string;
  connectedAccountId: string;
  checkoutSessionId: string;
  paymentIntentId: string;
  currency: string;
  additionalChargeAmountCents: number;
  additionalPlatformFeeAmountCents: number;
  additionalHostPayoutAmountCents: number;
};

function paymentError(input: {
  code: string;
  message: string;
  statusCode?: number;
  details?: unknown;
}) {
  return new GuestReservationModificationError({
    code: input.code,
    message: input.message,
    statusCode: input.statusCode ?? 409,
    details: input.details,
  });
}

function requireText(value: unknown, code: string) {
  const normalized = String(value ?? "").trim();

  if (!normalized) {
    throw paymentError({
      code,
      message: "Stripe modification payment metadata is incomplete.",
    });
  }

  return normalized;
}

function toCents(value: MoneyValue, code: string) {
  const amount = Number(value);
  const cents = Math.round(amount * 100);

  if (!Number.isFinite(amount) || !Number.isInteger(cents) || cents < 0) {
    throw paymentError({
      code,
      message: "Stripe modification payment amounts are invalid.",
    });
  }

  return cents;
}

function metadataCents(value: unknown, code: string) {
  const normalized = String(value ?? "").trim();

  if (!/^\d+$/.test(normalized)) {
    throw paymentError({
      code,
      message: "Stripe modification payment metadata amounts are invalid.",
    });
  }

  const cents = Number(normalized);

  if (!Number.isSafeInteger(cents) || cents < 0) {
    throw paymentError({
      code,
      message: "Stripe modification payment metadata amounts are invalid.",
    });
  }

  return cents;
}

function objectId(value: unknown) {
  if (typeof value === "string") {
    return value.trim() || null;
  }

  if (value && typeof value === "object" && "id" in value) {
    return String((value as { id?: unknown }).id ?? "").trim() || null;
  }

  return null;
}

export function buildGuestReservationModificationPaidCheckoutContract(input: {
  session: Stripe.Checkout.Session;
  modification: ModificationPaymentSnapshot;
}): GuestReservationModificationPaidCheckoutContract {
  const metadata = input.session.metadata ?? {};
  const flow = requireText(
    metadata.flow,
    "RESERVATION_MODIFICATION_PAYMENT_FLOW_MISSING"
  );

  if (flow !== MODIFICATION_PAYMENT_FLOW) {
    throw paymentError({
      code: "RESERVATION_MODIFICATION_PAYMENT_FLOW_MISMATCH",
      message: "Stripe Checkout does not belong to a reservation modification.",
    });
  }

  if (input.session.payment_status !== "paid") {
    throw paymentError({
      code: "RESERVATION_MODIFICATION_PAYMENT_NOT_PAID",
      message: "The reservation modification payment is not complete.",
    });
  }

  const modificationId = requireText(
    metadata.reservationModificationId,
    "RESERVATION_MODIFICATION_PAYMENT_ID_MISSING"
  );
  const reservationId = requireText(
    metadata.reservationId,
    "RESERVATION_MODIFICATION_PAYMENT_RESERVATION_ID_MISSING"
  );
  const propertyId = requireText(
    metadata.propertyId,
    "RESERVATION_MODIFICATION_PAYMENT_PROPERTY_ID_MISSING"
  );
  const connectedAccountId = requireText(
    metadata.connectedAccountId,
    "RESERVATION_MODIFICATION_PAYMENT_DESTINATION_MISSING"
  );
  const paymentIntentId = objectId(input.session.payment_intent);

  if (!paymentIntentId) {
    throw paymentError({
      code: "RESERVATION_MODIFICATION_PAYMENT_INTENT_MISSING",
      message: "Stripe PaymentIntent is missing from the paid Checkout.",
    });
  }

  const additionalChargeAmountCents = metadataCents(
    metadata.additionalChargeAmountCents,
    "RESERVATION_MODIFICATION_PAYMENT_AMOUNT_METADATA_INVALID"
  );
  const additionalPlatformFeeAmountCents = metadataCents(
    metadata.additionalPlatformFeeAmountCents,
    "RESERVATION_MODIFICATION_PAYMENT_PLATFORM_FEE_METADATA_INVALID"
  );
  const additionalHostPayoutAmountCents = metadataCents(
    metadata.additionalHostPayoutAmountCents,
    "RESERVATION_MODIFICATION_PAYMENT_HOST_PAYOUT_METADATA_INVALID"
  );
  const storedChargeAmountCents = toCents(
    input.modification.additionalChargeAmount,
    "RESERVATION_MODIFICATION_PAYMENT_AMOUNT_INVALID"
  );
  const storedPlatformFeeAmountCents = toCents(
    input.modification.additionalPlatformFeeAmount,
    "RESERVATION_MODIFICATION_PAYMENT_PLATFORM_FEE_INVALID"
  );
  const storedHostPayoutAmountCents = toCents(
    input.modification.additionalHostPayoutAmount,
    "RESERVATION_MODIFICATION_PAYMENT_HOST_PAYOUT_INVALID"
  );
  const sessionAmountCents = Number(input.session.amount_total);
  const currency = String(input.session.currency ?? "").trim().toLowerCase();
  const storedCurrency = input.modification.currency.trim().toLowerCase();

  const identityMatches =
    modificationId === input.modification.id &&
    reservationId === input.modification.reservationId &&
    reservationId === input.modification.reservation.id &&
    propertyId === input.modification.reservation.propertyId &&
    input.session.client_reference_id === modificationId &&
    input.modification.stripeCheckoutSessionId === input.session.id;

  if (!identityMatches) {
    throw paymentError({
      code: "RESERVATION_MODIFICATION_PAYMENT_IDENTITY_MISMATCH",
      message: "Stripe Checkout does not match the stored modification.",
    });
  }

  if (
    input.modification.financialAction !==
    ReservationModificationFinancialAction.ADDITIONAL_PAYMENT_REQUIRED
  ) {
    throw paymentError({
      code: "RESERVATION_MODIFICATION_PAYMENT_ACTION_INVALID",
      message: "This modification does not require an additional payment.",
    });
  }

  const amountsMatch =
    Number.isSafeInteger(sessionAmountCents) &&
    sessionAmountCents > 0 &&
    additionalChargeAmountCents === sessionAmountCents &&
    additionalChargeAmountCents === storedChargeAmountCents &&
    additionalPlatformFeeAmountCents === storedPlatformFeeAmountCents &&
    additionalHostPayoutAmountCents === storedHostPayoutAmountCents &&
    additionalPlatformFeeAmountCents + additionalHostPayoutAmountCents ===
      additionalChargeAmountCents;

  if (!amountsMatch) {
    throw paymentError({
      code: "RESERVATION_MODIFICATION_PAYMENT_AMOUNT_MISMATCH",
      message: "Stripe Checkout amounts do not match the modification.",
    });
  }

  if (!currency || currency !== storedCurrency) {
    throw paymentError({
      code: "RESERVATION_MODIFICATION_PAYMENT_CURRENCY_MISMATCH",
      message: "Stripe Checkout currency does not match the modification.",
    });
  }

  if (
    connectedAccountId !== input.modification.stripeConnectedAccountId ||
    connectedAccountId !==
      input.modification.reservation.stripeConnectedAccountId
  ) {
    throw paymentError({
      code: "RESERVATION_MODIFICATION_PAYMENT_DESTINATION_MISMATCH",
      message: "Stripe Connect destination does not match the modification.",
    });
  }

  return {
    modificationId,
    reservationId,
    propertyId,
    connectedAccountId,
    checkoutSessionId: input.session.id,
    paymentIntentId,
    currency,
    additionalChargeAmountCents,
    additionalPlatformFeeAmountCents,
    additionalHostPayoutAmountCents,
  };
}

async function retrieveFinancialEvidence(
  contract: GuestReservationModificationPaidCheckoutContract
) {
  const paymentIntent = await stripe.paymentIntents.retrieve(
    contract.paymentIntentId,
    {
      expand: [
        "latest_charge",
        "latest_charge.transfer",
        "latest_charge.application_fee",
      ],
    }
  );
  const paymentIntentAny = paymentIntent as any;
  const paymentIntentDestination = objectId(
    paymentIntentAny.transfer_data?.destination
  );

  if (
    paymentIntent.status !== "succeeded" ||
    paymentIntent.amount_received !== contract.additionalChargeAmountCents ||
    paymentIntent.currency.toLowerCase() !== contract.currency ||
    paymentIntent.application_fee_amount !==
      (contract.additionalPlatformFeeAmountCents || null) ||
    paymentIntentDestination !== contract.connectedAccountId ||
    paymentIntent.metadata?.flow !== MODIFICATION_PAYMENT_FLOW ||
    paymentIntent.metadata?.reservationModificationId !==
      contract.modificationId ||
    paymentIntent.metadata?.reservationId !== contract.reservationId ||
    paymentIntent.metadata?.propertyId !== contract.propertyId
  ) {
    throw paymentError({
      code: "RESERVATION_MODIFICATION_PAYMENT_INTENT_MISMATCH",
      message: "Stripe PaymentIntent does not match the modification contract.",
    });
  }

  let charge: Stripe.Charge;
  const latestCharge = paymentIntent.latest_charge;

  if (!latestCharge) {
    throw paymentError({
      code: "RESERVATION_MODIFICATION_PAYMENT_CHARGE_MISSING",
      message: "Stripe Charge is not available for the paid modification.",
    });
  }

  if (typeof latestCharge === "string") {
    charge = await stripe.charges.retrieve(latestCharge, {
      expand: ["transfer", "application_fee"],
    });
  } else {
    charge = latestCharge;
  }

  const chargeAny = charge as any;
  const chargePaymentIntentId = objectId(charge.payment_intent);
  const transferId = objectId(chargeAny.transfer);
  const applicationFeeId = objectId(chargeAny.application_fee);

  if (
    charge.status !== "succeeded" ||
    charge.paid !== true ||
    charge.amount !== contract.additionalChargeAmountCents ||
    charge.currency.toLowerCase() !== contract.currency ||
    chargePaymentIntentId !== contract.paymentIntentId ||
    !transferId ||
    (contract.additionalPlatformFeeAmountCents > 0 && !applicationFeeId)
  ) {
    throw paymentError({
      code: "RESERVATION_MODIFICATION_PAYMENT_CHARGE_MISMATCH",
      message: "Stripe Charge evidence does not match the modification.",
    });
  }

  const transfer =
    typeof chargeAny.transfer === "string"
      ? await stripe.transfers.retrieve(transferId)
      : (chargeAny.transfer as Stripe.Transfer);

  if (
    transfer.amount !== contract.additionalHostPayoutAmountCents ||
    transfer.currency.toLowerCase() !== contract.currency ||
    objectId(transfer.destination) !== contract.connectedAccountId
  ) {
    throw paymentError({
      code: "RESERVATION_MODIFICATION_PAYMENT_TRANSFER_MISMATCH",
      message: "Stripe Transfer evidence does not match the host payout.",
    });
  }

  let applicationFee: Stripe.ApplicationFee | null = null;

  if (contract.additionalPlatformFeeAmountCents > 0) {
    const resolvedApplicationFee =
      typeof chargeAny.application_fee === "string"
        ? await stripe.applicationFees.retrieve(applicationFeeId!)
        : (chargeAny.application_fee as Stripe.ApplicationFee);

    if (
      resolvedApplicationFee.amount !==
        contract.additionalPlatformFeeAmountCents ||
      resolvedApplicationFee.currency.toLowerCase() !== contract.currency ||
      objectId(resolvedApplicationFee.account) !== contract.connectedAccountId ||
      objectId(resolvedApplicationFee.charge) !== charge.id
    ) {
      throw paymentError({
        code: "RESERVATION_MODIFICATION_PAYMENT_APPLICATION_FEE_MISMATCH",
        message: "Stripe Application Fee evidence does not match the platform fee.",
      });
    }

    applicationFee = resolvedApplicationFee;
  }

  return {
    stripePaymentIntentId: paymentIntent.id,
    stripeChargeId: charge.id,
    stripeTransferId: transfer.id,
    stripeApplicationFeeId: applicationFee?.id ?? null,
  };
}

export async function handleGuestReservationModificationCheckoutPaid(
  session: Stripe.Checkout.Session
) {
  const modificationId = String(
    session.metadata?.reservationModificationId ?? ""
  ).trim();

  if (session.metadata?.flow !== MODIFICATION_PAYMENT_FLOW) {
    return { handled: false as const };
  }

  try {
    let modification = await prisma.reservationModification.findUnique({
      where: { id: modificationId },
      include: {
        reservation: {
          select: {
            id: true,
            propertyId: true,
            stripeConnectedAccountId: true,
          },
        },
      },
    });

    if (!modification) {
      throw paymentError({
        code: "RESERVATION_MODIFICATION_NOT_FOUND",
        message: "Reservation modification payment record was not found.",
        statusCode: 404,
      });
    }

    const contract = buildGuestReservationModificationPaidCheckoutContract({
      session,
      modification,
    });
    const replayStatuses: ReservationModificationStatus[] = [
      ReservationModificationStatus.PAYMENT_PROCESSING,
      ReservationModificationStatus.APPLYING,
      ReservationModificationStatus.APPLIED,
    ];

    if (modification.status === ReservationModificationStatus.AWAITING_PAYMENT) {
      await prisma.reservationModification.updateMany({
        where: {
          id: modification.id,
          status: ReservationModificationStatus.AWAITING_PAYMENT,
          stripeCheckoutSessionId: contract.checkoutSessionId,
        },
        data: {
          status: ReservationModificationStatus.PAYMENT_PROCESSING,
          stripePaymentStatus: "paid",
          failureCode: null,
          failureMessage: null,
          failureDetails: Prisma.DbNull,
        },
      });

      modification = await prisma.reservationModification.findUniqueOrThrow({
        where: { id: modification.id },
        include: {
          reservation: {
            select: {
              id: true,
              propertyId: true,
              stripeConnectedAccountId: true,
            },
          },
        },
      });
    }

    if (!replayStatuses.includes(modification.status)) {
      throw paymentError({
        code: "RESERVATION_MODIFICATION_PAYMENT_STATUS_INVALID",
        message: "This modification cannot accept a completed payment.",
        details: { status: modification.status },
      });
    }

    if (modification.status === ReservationModificationStatus.APPLIED) {
      const applied = await applyGuestReservationModification({
        modificationId: modification.id,
      });

      return { handled: true as const, paymentReplay: true, applied };
    }

    if (modification.status === ReservationModificationStatus.APPLYING) {
      const refsMatch =
        modification.stripePaymentStatus === "paid" &&
        modification.stripePaymentIntentId === contract.paymentIntentId &&
        Boolean(modification.stripeChargeId) &&
        Boolean(modification.stripeTransferId) &&
        (contract.additionalPlatformFeeAmountCents === 0 ||
          Boolean(modification.stripeApplicationFeeId));

      if (!refsMatch) {
        throw paymentError({
          code: "RESERVATION_MODIFICATION_PAYMENT_EVIDENCE_CONFLICT",
          message: "Stored Stripe payment evidence is incomplete or conflicting.",
        });
      }

      const applied = await applyGuestReservationModification({
        modificationId: modification.id,
      });

      return { handled: true as const, paymentReplay: true, applied };
    }

    const evidence = await retrieveFinancialEvidence(contract);
    const persisted = await prisma.reservationModification.updateMany({
      where: {
        id: modification.id,
        status: ReservationModificationStatus.PAYMENT_PROCESSING,
        stripeCheckoutSessionId: contract.checkoutSessionId,
      },
      data: {
        status: ReservationModificationStatus.APPLYING,
        stripePaymentStatus: "paid",
        ...evidence,
        failureCode: null,
        failureMessage: null,
        failureDetails: Prisma.DbNull,
      },
    });

    if (persisted.count === 0) {
      throw paymentError({
        code: "RESERVATION_MODIFICATION_PAYMENT_PERSISTENCE_CONFLICT",
        message: "Stripe payment evidence could not be persisted safely.",
      });
    }

    const applied = await applyGuestReservationModification({
      modificationId: modification.id,
    });

    return { handled: true as const, paymentReplay: false, applied };
  } catch (error: any) {
    if (modificationId) {
      await prisma.reservationModification
        .updateMany({
          where: {
            id: modificationId,
            status: {
              in: [
                ReservationModificationStatus.AWAITING_PAYMENT,
                ReservationModificationStatus.PAYMENT_PROCESSING,
              ],
            },
          },
          data: {
            failureCode:
              error instanceof GuestReservationModificationError
                ? error.code
                : "RESERVATION_MODIFICATION_PAYMENT_PROCESSING_FAILED",
            failureMessage: String(
              error?.message ?? "Modification payment processing failed."
            ).slice(0, 500),
            failureDetails: {
              retryable:
                !(error instanceof GuestReservationModificationError) ||
                error.statusCode >= 500,
            },
          },
        })
        .catch(() => {});
    }

    throw error;
  }
}
