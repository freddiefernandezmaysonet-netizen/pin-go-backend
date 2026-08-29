import type { PrismaClient } from "@prisma/client";

export type GuestJourneyAccessHandoffOperation =
  | "PROVISION"
  | "REVOKE";

export type GuestJourneyAccessHandoffWindow = {
  enabled: boolean;
  horizonDays: number;
  lookbackDays: number;
};

export type GuestJourneyAccessHandoffDecision =
  | {
      owner: "LEGACY";
      reason:
        | "ACCESS_OWNER_DISABLED_OR_OUT_OF_SCOPE"
        | "OUTSIDE_APMS_ADOPTION_WINDOW_WITHOUT_DURABLE_ACCESS_OWNERSHIP";
      intentId: null;
    }
  | {
      owner: "ACCESS_OWNER";
      reason: "DURABLE_ACCESS_INTENT_PRESENT";
      intentId: string;
    }
  | {
      owner: "APMS_PENDING";
      reason: "APMS_ADOPTION_WINDOW_PENDING_DURABLE_ACCESS_INTENT";
      intentId: string | null;
    }
  | {
      owner: "BLOCKED";
      reason:
        | "ACCESS_OWNER_HANDOFF_IDENTITY_INCOMPLETE"
        | "ACCESS_OWNER_HANDOFF_DEPENDENCY_DISABLED"
        | "ACCESS_OWNER_HANDOFF_RESERVATION_NOT_FOUND"
        | "ACCESS_OWNER_HANDOFF_SCOPE_MISMATCH"
        | "ACCESS_OWNER_HANDOFF_EXHAUSTED"
        | "ACCESS_OWNER_HANDOFF_TERMINAL_CONTRADICTION"
        | "ACCESS_OWNER_HANDOFF_UNKNOWN_STATUS"
        | "ACCESS_OWNER_HANDOFF_LOOKUP_FAILED";
      intentId: string | null;
      errorCode: string;
    };

export type GuestJourneyAccessOwnerHandoffDb = Pick<
  PrismaClient,
  "reservation" | "guestJourneyCoordinationIntent"
>;

const ACTIVE_HANDOFF_STATUSES = [
  "PENDING",
  "CLAIMED",
  "WAITING_FOR_EVIDENCE",
  "RETRYABLE",
] as const;

const DAY_MS = 24 * 60 * 60 * 1000;

function intentTypeFor(
  operation: GuestJourneyAccessHandoffOperation
): "REQUEST_ACCESS_PROVISIONING" | "REQUEST_ACCESS_REVOCATION_CHECK" {
  return operation === "PROVISION"
    ? "REQUEST_ACCESS_PROVISIONING"
    : "REQUEST_ACCESS_REVOCATION_CHECK";
}

function stableErrorCode(error: unknown): string {
  const raw =
    error instanceof Error
      ? error.message
      : String(error ?? "");

  return (
    raw
      .split(":", 1)[0]
      .trim()
      .replace(/[^A-Z0-9_]/gi, "_")
      .toUpperCase() || "UNKNOWN_ERROR"
  );
}

function validWindow(
  window: GuestJourneyAccessHandoffWindow
): boolean {
  return (
    window.enabled === true &&
    Number.isSafeInteger(window.horizonDays) &&
    window.horizonDays >= 1 &&
    window.horizonDays <= 365 &&
    Number.isSafeInteger(window.lookbackDays) &&
    window.lookbackDays >= 1 &&
    window.lookbackDays <= 30
  );
}

function validDate(value: unknown): value is Date {
  return (
    value instanceof Date &&
    !Number.isNaN(value.getTime())
  );
}

function reservationFallsInsideWindow(
  reservation: {
    status: string;
    checkIn: Date;
    checkOut: Date;
    cancelledAt: Date | null;
    updatedAt: Date;
  },
  window: GuestJourneyAccessHandoffWindow,
  now: Date
): boolean {
  const earliestRelevantAt = new Date(
    now.getTime() - window.lookbackDays * DAY_MS
  );
  const latestRelevantAt = new Date(
    now.getTime() + window.horizonDays * DAY_MS
  );

  if (reservation.status === "ACTIVE") {
    return (
      reservation.checkIn <= latestRelevantAt &&
      reservation.checkOut >= earliestRelevantAt
    );
  }

  if (reservation.status === "CANCELLED") {
    if (reservation.cancelledAt) {
      return reservation.cancelledAt >= earliestRelevantAt;
    }
    return reservation.updatedAt >= earliestRelevantAt;
  }

  return false;
}

function reservationCanBeAdoptedThisTick(
  reservation: {
    status: string;
    checkIn: Date;
    checkOut: Date;
    cancelledAt: Date | null;
    updatedAt: Date;
  },
  internalReconcile: GuestJourneyAccessHandoffWindow,
  coordination: GuestJourneyAccessHandoffWindow,
  now: Date
): boolean {
  return (
    reservationFallsInsideWindow(
      reservation,
      internalReconcile,
      now
    ) &&
    reservationFallsInsideWindow(
      reservation,
      coordination,
      now
    )
  );
}

/**
 * Read-only ownership proof for the legacy -> E8 cutover.
 *
 * Invariants:
 * - canary scope alone never proves operation ownership;
 * - an active durable operation-specific ACCESS intent always belongs to E8;
 * - work that E3 + E4 can adopt in the current tick is held at the APMS
 *   boundary until E4 materializes the durable intent (legacy never races it);
 * - legacy debt outside the E3/E4 adoption window remains legacy unless a
 *   durable E8 intent already exists;
 * - exhausted/contradictory durable E8 ownership never falls back to a
 *   provider-capable legacy path;
 * - every lookup/configuration ambiguity fails closed.
 *
 * The service is read-only and never calls TTLock or any external provider.
 */
export async function resolveGuestJourneyAccessOwnerHandoff(
  db: GuestJourneyAccessOwnerHandoffDb,
  input: {
    accessOwnerInScope: boolean;
    reservationId?: string | null;
    organizationId?: string | null;
    propertyId?: string | null;
    operation: GuestJourneyAccessHandoffOperation;
    now: Date;
    internalReconcile: GuestJourneyAccessHandoffWindow;
    coordination: GuestJourneyAccessHandoffWindow;
  }
): Promise<GuestJourneyAccessHandoffDecision> {
  if (!input.accessOwnerInScope) {
    return {
      owner: "LEGACY",
      reason:
        "ACCESS_OWNER_DISABLED_OR_OUT_OF_SCOPE",
      intentId: null,
    };
  }

  const reservationId = String(
    input.reservationId ?? ""
  ).trim();
  const organizationId = String(
    input.organizationId ?? ""
  ).trim();
  const propertyId = String(
    input.propertyId ?? ""
  ).trim();

  if (
    !reservationId ||
    !organizationId ||
    !propertyId ||
    !validDate(input.now)
  ) {
    return {
      owner: "BLOCKED",
      reason:
        "ACCESS_OWNER_HANDOFF_IDENTITY_INCOMPLETE",
      intentId: null,
      errorCode:
        "GUEST_JOURNEY_ACCESS_OWNER_HANDOFF_IDENTITY_INCOMPLETE",
    };
  }

  if (
    !validWindow(input.internalReconcile) ||
    !validWindow(input.coordination)
  ) {
    return {
      owner: "BLOCKED",
      reason:
        "ACCESS_OWNER_HANDOFF_DEPENDENCY_DISABLED",
      intentId: null,
      errorCode:
        "GUEST_JOURNEY_ACCESS_OWNER_HANDOFF_DEPENDENCY_DISABLED",
    };
  }

  try {
    const reservation = await db.reservation.findUnique({
      where: { id: reservationId },
      select: {
        id: true,
        propertyId: true,
        status: true,
        checkIn: true,
        checkOut: true,
        cancelledAt: true,
        updatedAt: true,
        property: {
          select: {
            organizationId: true,
          },
        },
      },
    });

    if (!reservation) {
      return {
        owner: "BLOCKED",
        reason:
          "ACCESS_OWNER_HANDOFF_RESERVATION_NOT_FOUND",
        intentId: null,
        errorCode:
          "GUEST_JOURNEY_ACCESS_OWNER_HANDOFF_RESERVATION_NOT_FOUND",
      };
    }

    if (
      reservation.propertyId !== propertyId ||
      reservation.property.organizationId !== organizationId
    ) {
      return {
        owner: "BLOCKED",
        reason:
          "ACCESS_OWNER_HANDOFF_SCOPE_MISMATCH",
        intentId: null,
        errorCode:
          "GUEST_JOURNEY_ACCESS_OWNER_HANDOFF_SCOPE_MISMATCH",
      };
    }

    const intentType = intentTypeFor(input.operation);

    const activeIntent =
      await db.guestJourneyCoordinationIntent.findFirst({
        where: {
          reservationId,
          targetEngine: "ACCESS",
          intentType,
          status: {
            in: [...ACTIVE_HANDOFF_STATUSES],
          },
        },
        orderBy: [
          { createdAt: "desc" },
          { id: "asc" },
        ],
        select: {
          id: true,
          status: true,
        },
      });

    if (activeIntent) {
      return {
        owner: "ACCESS_OWNER",
        reason: "DURABLE_ACCESS_INTENT_PRESENT",
        intentId: activeIntent.id,
      };
    }

    const insideApmsAdoptionWindow =
      reservationCanBeAdoptedThisTick(
        reservation,
        input.internalReconcile,
        input.coordination,
        input.now
      );

    if (insideApmsAdoptionWindow) {
      return {
        owner: "APMS_PENDING",
        reason:
          "APMS_ADOPTION_WINDOW_PENDING_DURABLE_ACCESS_INTENT",
        intentId: null,
      };
    }

    const terminalIntent =
      await db.guestJourneyCoordinationIntent.findFirst({
        where: {
          reservationId,
          targetEngine: "ACCESS",
          intentType,
          status: {
            in: ["EXHAUSTED", "SUCCEEDED"],
          },
        },
        orderBy: [
          { createdAt: "desc" },
          { id: "asc" },
        ],
        select: {
          id: true,
          status: true,
        },
      });

    if (!terminalIntent) {
      return {
        owner: "LEGACY",
        reason:
          "OUTSIDE_APMS_ADOPTION_WINDOW_WITHOUT_DURABLE_ACCESS_OWNERSHIP",
        intentId: null,
      };
    }

    if (String(terminalIntent.status) === "EXHAUSTED") {
      return {
        owner: "BLOCKED",
        reason: "ACCESS_OWNER_HANDOFF_EXHAUSTED",
        intentId: terminalIntent.id,
        errorCode:
          "GUEST_JOURNEY_ACCESS_OWNER_HANDOFF_EXHAUSTED",
      };
    }

    if (String(terminalIntent.status) === "SUCCEEDED") {
      return {
        owner: "BLOCKED",
        reason:
          "ACCESS_OWNER_HANDOFF_TERMINAL_CONTRADICTION",
        intentId: terminalIntent.id,
        errorCode:
          "GUEST_JOURNEY_ACCESS_OWNER_HANDOFF_TERMINAL_CONTRADICTION",
      };
    }

    return {
      owner: "BLOCKED",
      reason: "ACCESS_OWNER_HANDOFF_UNKNOWN_STATUS",
      intentId: terminalIntent.id,
      errorCode:
        "GUEST_JOURNEY_ACCESS_OWNER_HANDOFF_UNKNOWN_STATUS",
    };
  } catch (error) {
    return {
      owner: "BLOCKED",
      reason:
        "ACCESS_OWNER_HANDOFF_LOOKUP_FAILED",
      intentId: null,
      errorCode: stableErrorCode(error),
    };
  }
}
