import { formatInTimeZone, fromZonedTime } from "date-fns-tz";

import type {
  PinAIActionBrokerPrepareResult,
  PinAIActionBrokerPublicProposal,
} from "../actions/action-broker.service.js";
import type {
  PinAIRuntimeRequest,
  PinAIRuntimeToolName,
} from "./contracts.js";
import type {
  PinAIConversationMemory,
} from "./conversation-memory.js";
import type {
  PinAIRuntimeToolExecutor,
} from "./tool-executor.js";

type ReservationModificationOptions =
  Readonly<{
    managementPhase?: string;
    reservation: Readonly<{
      current: Readonly<{
        checkIn?: Date;
        checkOut?: Date;
        adults: number;
        children: number;
        selectedAmenityIds:
          string[];
      }>;
    }>;
    property: Readonly<{
      timezone:
        | string
        | null;
      checkInTime:
        | string
        | null;
      checkOutTime:
        | string
        | null;
    }>;
  }>;

export type PinAIPrivateActionProposal =
  Readonly<{
    publicResult:
      PinAIActionBrokerPublicProposal;
    privateConfirmation:
      PinAIActionBrokerPrepareResult[
        "privateConfirmation"
      ];
  }>;

export type PinAIActionProposalRuntimeToolDependencies =
  Readonly<{
    delegate:
      PinAIRuntimeToolExecutor;
    enabled: boolean;
    guestToken: string;
    estimateInStayExtension?: (args: Readonly<Record<string, unknown>>) => Promise<Readonly<Record<string, unknown>> | null>;
    getModificationOptions:
      (input: Readonly<{
        guestToken: string;
        allowInStayExtension?: boolean;
      }>) =>
        Promise<
          ReservationModificationOptions
        >;
    prepareReservationModification:
      (
        input: Readonly<{
          operation?: "EXTEND_CHECKOUT_ONLY";
          guestToken: string;
          checkIn: Date;
          checkOut: Date;
          adults: number;
          children: number;
          selectedAmenityIds:
            string[];
          language:
            "en" | "es";
        }>,
      ) =>
        Promise<
          PinAIActionBrokerPrepareResult
        >;
  }>;

function parseDateOnly(
  value: unknown,
): string | null {
  if (
    typeof value !== "string"
  ) {
    return null;
  }

  const dateKey =
    value.trim();

  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(
      dateKey,
    )
  ) {
    return null;
  }

  const [year, month, day] =
    dateKey
      .split("-")
      .map(Number);
  const parsed =
    new Date(
      Date.UTC(
        year,
        month - 1,
        day,
      ),
    );

  return (
    parsed
      .toISOString()
      .slice(0, 10) ===
    dateKey
  )
    ? dateKey
    : null;
}

function normalizeLocalTime(
  value: unknown,
  fallback: string,
): string {
  return (
    typeof value === "string" &&
    /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(
      value,
    )
  )
    ? value
    : fallback;
}

function buildPropertyDate(
  dateKey: string,
  localTime: string,
  timezone: string,
): Date {
  const value =
    fromZonedTime(
      `${dateKey}T${localTime}:00`,
      timezone,
    );

  if (
    Number.isNaN(
      value.getTime(),
    )
  ) {
    throw new Error(
      "PIN_AI_RUNTIME_ACTION_PROPOSAL_PROPERTY_TIME_INVALID",
    );
  }

  return value;
}

function normalizedIds(
  value: unknown,
): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return Array.from(
    new Set(
      value
        .map((item) =>
          String(item)
            .trim(),
        )
        .filter(Boolean),
    ),
  ).sort();
}

function normalizeGuestCount(
  value: unknown,
  minimum: number,
  code: string,
): number {
  const parsed =
    Number(value);

  if (
    !Number.isInteger(parsed) ||
    parsed < minimum
  ) {
    throw new Error(code);
  }

  return parsed;
}

function modelSafeToolResult(
  proposal:
    PinAIActionBrokerPublicProposal,
) {
  return {
    decision:
      "ACTION_PROPOSAL_PREPARED",
    actionType:
      proposal.actionType,
    proposalId:
      proposal.proposalId,
    proposalCreated: true,
    requiresGuestConfirmation:
      true,
    authorizationGranted:
      false,
    actionExecuted:
      false,
    reservationChanged:
      false,
    chargeExecuted:
      false,
    refundExecuted:
      false,
    availabilityHeld:
      false,
    quote:
      proposal.quote,
    guestFacingConstraint:
      "A reviewable quote was prepared. Tell the guest the exact quote expiration and that availability is not held. Ask the guest to use the confirmation control in the interface. Do not claim the reservation changed or payment was collected.",
  } as const;
}

export class PinAIActionProposalRuntimeToolExecutor
  implements PinAIRuntimeToolExecutor {
  private privateProposal:
    PinAIPrivateActionProposal |
    null = null;

  private proposalKey:
    string |
    null = null;

  private modelSafeProposalResult:
    Readonly<
      Record<string, unknown>
    > |
    null = null;

  constructor(
    private readonly dependencies:
      PinAIActionProposalRuntimeToolDependencies,
  ) {}

  getPrivateActionProposal():
    PinAIPrivateActionProposal |
    null {
    return this.privateProposal;
  }

  async execute(
    tool:
      PinAIRuntimeToolName,
    args:
      Readonly<
        Record<
          string,
          unknown
        >
      >,
    request:
      PinAIRuntimeRequest,
    memory:
      PinAIConversationMemory,
  ): Promise<
    Readonly<
      Record<string, unknown>
    >
  > {
    if (tool === "calculate_extension_price" && this.dependencies.enabled && this.dependencies.estimateInStayExtension) {
      const estimate = await this.dependencies.estimateInStayExtension(args);
      if (estimate !== null) return estimate;
    }
    if (
      tool !==
      "prepare_reservation_modification"
    ) {
      return this.dependencies
        .delegate.execute(
          tool,
          args,
          request,
          memory,
        );
    }

    if (
      !this.dependencies.enabled
    ) {
      throw new Error(
        "PIN_AI_RUNTIME_ACTION_PROPOSAL_TOOL_DISABLED",
      );
    }

    const isExtension = args.operation === "EXTEND_CHECKOUT_ONLY";
    if (args.operation !== undefined && !isExtension) {
      throw new Error("PIN_AI_RUNTIME_ACTION_PROPOSAL_OPERATION_INVALID");
    }

    const proposedCheckInDate =
      parseDateOnly(
        args.proposedCheckInDate,
      );
    const proposedCheckOutDate =
      parseDateOnly(
        args.proposedCheckOutDate,
      );

    if (
      (!isExtension && !proposedCheckInDate) ||
      (args.proposedCheckInDate !== undefined && !proposedCheckInDate) ||
      !proposedCheckOutDate
    ) {
      throw new Error(
        "PIN_AI_RUNTIME_ACTION_PROPOSAL_DATES_INVALID",
      );
    }

    const key =
      `${isExtension ? "EXTEND_CHECKOUT_ONLY" : "CHANGE_DATES"}:${proposedCheckInDate ?? "preserve"}:${proposedCheckOutDate}`;

    if (
      this.proposalKey
    ) {
      if (
        this.proposalKey ===
          key &&
        this.modelSafeProposalResult
      ) {
        return this
          .modelSafeProposalResult;
      }

      throw new Error(
        "PIN_AI_RUNTIME_MULTIPLE_ACTION_PROPOSALS_FORBIDDEN",
      );
    }

    const options =
      await this.dependencies
        .getModificationOptions({
          ...(isExtension ? { allowInStayExtension: true } : {}),
          guestToken:
            this.dependencies
              .guestToken,
        });

    const timezone =
      String(
        options.property
          .timezone ??
        "",
      ).trim();

    if (!timezone) {
      throw new Error(
        "PIN_AI_RUNTIME_ACTION_PROPOSAL_PROPERTY_TIMEZONE_REQUIRED",
      );
    }

    const checkInTime =
      normalizeLocalTime(
        options.property
          .checkInTime,
        "16:00",
      );
    const checkOutTime =
      normalizeLocalTime(
        options.property
          .checkOutTime,
        "11:00",
      );

    if (options.managementPhase === "IN_STAY" && !isExtension) {
      throw new Error("PIN_AI_RUNTIME_IN_STAY_EXTENSION_OPERATION_REQUIRED");
    }
    const current = options.reservation.current;
    if (isExtension && (
      options.managementPhase !== "IN_STAY" ||
      !(current.checkIn instanceof Date) || !Number.isFinite(current.checkIn.getTime()) ||
      !(current.checkOut instanceof Date) || !Number.isFinite(current.checkOut.getTime())
    )) {
      throw new Error("PIN_AI_RUNTIME_IN_STAY_EXTENSION_CONTEXT_INVALID");
    }
    if (isExtension && proposedCheckInDate &&
      proposedCheckInDate !== formatInTimeZone(current.checkIn!, timezone, "yyyy-MM-dd")) {
      throw new Error("PIN_AI_RUNTIME_IN_STAY_CHECK_IN_IMMUTABLE");
    }
    const checkIn = isExtension
      ? new Date(current.checkIn!.getTime())
      : buildPropertyDate(proposedCheckInDate!, checkInTime, timezone);
    const checkOut =
      buildPropertyDate(
        proposedCheckOutDate,
        checkOutTime,
        timezone,
      );

    if (
      checkOut <= checkIn ||
      (isExtension && checkOut <= current.checkOut!)
    ) {
      throw new Error(
        "PIN_AI_RUNTIME_ACTION_PROPOSAL_DATES_INVALID",
      );
    }

    const adults =
      normalizeGuestCount(
        options.reservation
          .current.adults,
        1,
        "PIN_AI_RUNTIME_ACTION_PROPOSAL_ADULT_COUNT_INVALID",
      );
    const children =
      normalizeGuestCount(
        options.reservation
          .current.children,
        0,
        "PIN_AI_RUNTIME_ACTION_PROPOSAL_CHILD_COUNT_INVALID",
      );
    const selectedAmenityIds =
      normalizedIds(
        options.reservation
          .current
          .selectedAmenityIds,
      );
    const language:
      "en" | "es" =
      request.context
        .preferredLanguage ===
      "es"
        ? "es"
        : "en";

    const prepared =
      await this.dependencies
        .prepareReservationModification({
          ...(isExtension ? { operation: "EXTEND_CHECKOUT_ONLY" as const } : {}),
          guestToken:
            this.dependencies
              .guestToken,
          checkIn,
          checkOut,
          adults,
          children,
          selectedAmenityIds,
          language,
        });

    const publicResult =
      prepared.publicResult;
    const safeResult =
      modelSafeToolResult(
        publicResult,
      );

    this.proposalKey =
      key;
    this.privateProposal = {
      publicResult,
      privateConfirmation:
        prepared
          .privateConfirmation,
    };
    this.modelSafeProposalResult =
      safeResult;

    return safeResult;
  }
}
