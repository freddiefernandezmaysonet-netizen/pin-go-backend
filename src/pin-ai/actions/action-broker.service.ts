import {
  PinAIActionProposalType,
  type PrismaClient,
} from "@prisma/client";

import {
  confirmPinAIActionProposal,
  PinAIActionProposalError,
} from "./action-proposal.service.js";
import type {
  PinAIReservationModificationActionAdapter,
} from "./reservation-modification-action-adapter.service.js";

export type PinAIActionBrokerPrisma = Pick<
  PrismaClient,
  "pinAIActionProposal" | "reservation"
>;

export type PinAIActionBrokerPublicProposal =
  Readonly<{
    actionType:
      "RESERVATION_MODIFICATION";
    proposalId: string;
    requiresGuestConfirmation: true;
    actionExecuted: false;
    quote: Readonly<{
      quotedAt: Date;
      quoteExpiresAt: Date;
      quoteExpiresAtLocal: string;
      priceGuaranteedUntil: Date;
      propertyTimezone: string;
      availabilityCheckedAt: Date;
      availabilityHeld: false;
      currentTotalAmount: number;
      proposedTotalAmount: number;
      amountDifference: number;
      amountDifferenceCents: number;
      currency: string;
      financialAction: string;
    }>;
  }>;

export type PinAIActionBrokerPrivateConfirmation =
  Readonly<{
    proposalId: string;
    confirmationToken: string;
    expiresAt: Date;
  }>;

export type PinAIActionBrokerPrepareResult =
  Readonly<{
    publicResult:
      PinAIActionBrokerPublicProposal;
    privateConfirmation:
      PinAIActionBrokerPrivateConfirmation;
  }>;

export type PinAIActionBrokerExecuteResult =
  Readonly<{
    ok: true;
    actionType:
      "RESERVATION_MODIFICATION";
    proposalId: string;
    outcome:
      | "EXECUTED"
      | "WAITING_FOR_PAYMENT"
      | "WAITING_FOR_HOST"
      | "REVIEW_REQUIRED";
    actionExecuted: boolean;
    quoteExpiresAt: Date | null;
    quoteExpiresAtLocal:
      | string
      | null;
    propertyTimezone:
      | string
      | null;
    availabilityHeld: false;
    modificationId:
      | string
      | null;
    modificationStatus:
      | string
      | null;
    checkoutUrl:
      | string
      | null;
    paymentExpiresAt:
      | Date
      | null;
    amountDifference:
      | number
      | null;
    amountDifferenceCents:
      | number
      | null;
    currency:
      | string
      | null;
    reasonCode:
      | string
      | null;
  }>;

export class PinAIActionBrokerError
  extends Error {
  constructor(
    readonly code:
      | "INVALID_ACTION_TYPE"
      | "ACTION_PROPOSAL_EXPIRED"
      | "ACTION_PROPOSAL_NOT_CONFIRMABLE"
      | "ACTION_PROPOSAL_SCOPE_MISMATCH"
      | "ACTION_CONFIRMATION_FAILED",
    readonly statusCode = 409,
  ) {
    super(
      `PIN_AI_ACTION_BROKER_${code}`,
    );
    this.name =
      "PinAIActionBrokerError";
  }
}

type BrokerDependencies =
  Readonly<{
    prisma:
      PinAIActionBrokerPrisma;
    reservationModification:
      Pick<
        PinAIReservationModificationActionAdapter,
        "prepare" | "execute"
      >;
    confirmProposal: (
      input: Readonly<{
        prisma: PrismaClient;
        guestToken: unknown;
        proposalId: unknown;
        confirmationToken:
          unknown;
        now?: Date;
      }>,
    ) => Promise<
      Readonly<{
        proposalConfirmed: true;
        actionExecuted: false;
        proposal: Readonly<{
          id: string;
          actionType:
            PinAIActionProposalType;
          expiresAt: Date;
        }>;
      }>
    >;
    now: () => Date;
  }>;

function normalizeOutcome(
  value: unknown,
):
  | "EXECUTED"
  | "WAITING_FOR_PAYMENT"
  | "WAITING_FOR_HOST"
  | "REVIEW_REQUIRED" {
  switch (value) {
    case "EXECUTED":
    case "WAITING_FOR_PAYMENT":
    case "WAITING_FOR_HOST":
    case "REVIEW_REQUIRED":
      return value;
    default:
      throw new PinAIActionBrokerError(
        "ACTION_CONFIRMATION_FAILED",
        502,
      );
  }
}

function nullableDate(
  value: unknown,
): Date | null {
  if (
    value === null ||
    value === undefined
  ) {
    return null;
  }

  const parsed =
    value instanceof Date
      ? new Date(value)
      : new Date(
          String(value),
        );

  if (
    Number.isNaN(
      parsed.getTime(),
    )
  ) {
    throw new PinAIActionBrokerError(
      "ACTION_CONFIRMATION_FAILED",
      502,
    );
  }

  return parsed;
}

function nullableNumber(
  value: unknown,
): number | null {
  if (
    value === null ||
    value === undefined
  ) {
    return null;
  }

  const parsed =
    Number(value);

  if (!Number.isFinite(parsed)) {
    throw new PinAIActionBrokerError(
      "ACTION_CONFIRMATION_FAILED",
      502,
    );
  }

  return parsed;
}

function nullableString(
  value: unknown,
): string | null {
  if (
    value === null ||
    value === undefined
  ) {
    return null;
  }

  const normalized =
    String(value).trim();

  if (!normalized) {
    return null;
  }

  return normalized;
}

export class PinAIActionBroker {
  constructor(
    private readonly dependencies:
      BrokerDependencies,
  ) {}

  async prepareReservationModification(
    input: Parameters<
      PinAIReservationModificationActionAdapter["prepare"]
    >[0],
  ): Promise<
    PinAIActionBrokerPrepareResult
  > {
    const prepared =
      await this.dependencies
        .reservationModification
        .prepare(input);

    if (
      prepared.proposal.actionType !==
      PinAIActionProposalType
        .RESERVATION_MODIFICATION
    ) {
      throw new PinAIActionBrokerError(
        "INVALID_ACTION_TYPE",
        409,
      );
    }

    return {
      publicResult: {
        actionType:
          "RESERVATION_MODIFICATION",
        proposalId:
          prepared.proposal.id,
        requiresGuestConfirmation:
          true,
        actionExecuted:
          false,
        quote:
          prepared.quote,
      },
      privateConfirmation: {
        proposalId:
          prepared.proposal.id,
        confirmationToken:
          prepared.confirmationToken,
        expiresAt:
          prepared.proposal
            .expiresAt,
      },
    };
  }

  async confirmAndExecute(
    input: Readonly<{
      guestToken: unknown;
      proposalId: unknown;
      confirmationToken:
        unknown;
    }>,
  ): Promise<
    PinAIActionBrokerExecuteResult
  > {
    const now =
      this.dependencies.now();

    let confirmed;

    try {
      confirmed =
        await this.dependencies
          .confirmProposal({
            prisma:
              this.dependencies
                .prisma as PrismaClient,
            guestToken:
              input.guestToken,
            proposalId:
              input.proposalId,
            confirmationToken:
              input
                .confirmationToken,
            now,
          });
    } catch (error) {
      if (
        error instanceof
          PinAIActionProposalError
      ) {
        if (
          error.code ===
          "PROPOSAL_EXPIRED"
        ) {
          return {
            ok: true,
            actionType:
              "RESERVATION_MODIFICATION",
            proposalId:
              String(
                input.proposalId ??
                "",
              ),
            outcome:
              "REVIEW_REQUIRED",
            actionExecuted:
              false,
            quoteExpiresAt:
              null,
            quoteExpiresAtLocal:
              null,
            propertyTimezone:
              null,
            availabilityHeld:
              false,
            modificationId:
              null,
            modificationStatus:
              null,
            checkoutUrl:
              null,
            paymentExpiresAt:
              null,
            amountDifference:
              null,
            amountDifferenceCents:
              null,
            currency:
              null,
            reasonCode:
              "QUOTE_EXPIRED",
          };
        }

        if (
          error.code ===
            "PROPOSAL_NOT_CONFIRMABLE" ||
          error.code ===
            "PROPOSAL_SUPERSEDED"
        ) {
          throw new PinAIActionBrokerError(
            "ACTION_PROPOSAL_NOT_CONFIRMABLE",
            409,
          );
        }

        if (
          error.code ===
            "PROPOSAL_SCOPE_MISMATCH" ||
          error.code ===
            "PROPOSAL_NOT_FOUND"
        ) {
          throw new PinAIActionBrokerError(
            "ACTION_PROPOSAL_SCOPE_MISMATCH",
            404,
          );
        }
      }

      throw error;
    }

    if (
      confirmed.proposal
        .actionType !==
      PinAIActionProposalType
        .RESERVATION_MODIFICATION
    ) {
      throw new PinAIActionBrokerError(
        "INVALID_ACTION_TYPE",
        409,
      );
    }

    const executed =
      await this.dependencies
        .reservationModification
        .execute({
          guestToken:
            String(
              input.guestToken ??
              "",
            ),
          proposalId:
            confirmed.proposal.id,
        });

    return {
      ok: true,
      actionType:
        "RESERVATION_MODIFICATION",
      proposalId:
        confirmed.proposal.id,
      outcome:
        normalizeOutcome(
          executed.outcome,
        ),
      actionExecuted:
        executed.actionExecuted ===
        true,
      quoteExpiresAt:
        nullableDate(
          executed
            .quoteExpiresAt,
        ),
      quoteExpiresAtLocal:
        nullableString(
          executed
            .quoteExpiresAtLocal,
        ),
      propertyTimezone:
        nullableString(
          executed
            .propertyTimezone,
        ),
      availabilityHeld:
        false,
      modificationId:
        nullableString(
          executed
            .modificationId,
        ),
      modificationStatus:
        nullableString(
          executed
            .modificationStatus,
        ),
      checkoutUrl:
        nullableString(
          executed
            .checkoutUrl,
        ),
      paymentExpiresAt:
        nullableDate(
          executed
            .paymentExpiresAt,
        ),
      amountDifference:
        nullableNumber(
          executed
            .amountDifference,
        ),
      amountDifferenceCents:
        nullableNumber(
          executed
            .amountDifferenceCents,
        ),
      currency:
        nullableString(
          executed.currency,
        ),
      reasonCode:
        nullableString(
          executed.reasonCode,
        ),
    };
  }
}

export function createPinAIActionBroker(
  input: Readonly<{
    prisma:
      PinAIActionBrokerPrisma;
    reservationModification:
      Pick<
        PinAIReservationModificationActionAdapter,
        "prepare" | "execute"
      >;
    now?: () => Date;
  }>,
) {
  return new PinAIActionBroker({
    prisma:
      input.prisma,
    reservationModification:
      input
        .reservationModification,
    confirmProposal:
      confirmPinAIActionProposal,
    now:
      input.now ??
      (() => new Date()),
  });
}
