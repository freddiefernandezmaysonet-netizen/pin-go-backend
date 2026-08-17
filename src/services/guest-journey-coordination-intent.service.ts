import {
  createHash,
  randomUUID,
} from "node:crypto";

import {
  GuestJourneyCoordinationIntentStatus,
  Prisma,
} from "@prisma/client";

import {
  GUEST_JOURNEY_COORDINATION_INTENT_TYPES,
  GUEST_JOURNEY_COORDINATION_INTENT_VERSION,
  GUEST_JOURNEY_TARGET_ENGINES,
} from "./guest-journey-contract";

import type {
  GuestJourneyCoordinationIntentSnapshot,
  GuestJourneyCoordinationIntentType,
  GuestJourneyTargetEngine,
  ProposedJourneyCoordinationIntent,
} from "./guest-journey-contract";

const DEFAULT_LEASE_DURATION_MS =
  60_000;

const MINIMUM_LEASE_DURATION_MS =
  1_000;

const MAXIMUM_LEASE_DURATION_MS =
  60 * 60 * 1_000;

const MAXIMUM_ERROR_LENGTH =
  4_000;

const ACTIVE_COORDINATION_INTENT_STATUSES = [
  GuestJourneyCoordinationIntentStatus.PENDING,
  GuestJourneyCoordinationIntentStatus.CLAIMED,
  GuestJourneyCoordinationIntentStatus
    .WAITING_FOR_EVIDENCE,
  GuestJourneyCoordinationIntentStatus.RETRYABLE,
] as const;

const coordinationIntentSelect = {
  id: true,
  intentKey: true,
  reservationId: true,
  journeyId: true,

  contractVersion: true,
  intentType: true,
  targetEngine: true,
  reasonCode: true,
  expectedOutcomeCode: true,
  evidenceFingerprint: true,

  status: true,

  claimCount: true,
  leaseToken: true,
  claimedAt: true,
  leaseExpiresAt: true,
  lastAttemptAt: true,
  nextActionAt: true,

  succeededAt: true,
  exhaustedAt: true,
  supersededAt: true,

  outcomeEvidenceFingerprint: true,
  lastError: true,

  createdAt: true,
  updatedAt: true,
} satisfies Prisma.GuestJourneyCoordinationIntentSelect;

type CoordinationIntentRecord =
  Prisma.GuestJourneyCoordinationIntentGetPayload<{
    select: typeof coordinationIntentSelect;
  }>;

export type GuestJourneyCoordinationIntentTransactionClient =
  Pick<
    Prisma.TransactionClient,
    | "guestJourney"
    | "guestJourneyCoordinationIntent"
  >;

export type EnsureGuestJourneyCoordinationIntentInput = {
  reservationId: string;
  journeyId: string;
  evidenceFingerprint: string;
  intent: ProposedJourneyCoordinationIntent;
};

export type EnsureGuestJourneyCoordinationIntentResult = {
  created: boolean;
  intent: GuestJourneyCoordinationIntentSnapshot;
};

export type ClaimGuestJourneyCoordinationIntentInput = {
  intentId: string;
  targetEngine: GuestJourneyTargetEngine;
  now: Date;
  leaseDurationMs?: number;
};

export type ClaimGuestJourneyCoordinationIntentResult = {
  claimed: boolean;
  leaseToken: string | null;
  intent: GuestJourneyCoordinationIntentSnapshot;
};

export type CompleteClaimedIntentTransitionInput = {
  intentId: string;
  leaseToken: string;
  now: Date;
};

export type MarkGuestJourneyCoordinationIntentRetryableInput =
  CompleteClaimedIntentTransitionInput & {
    nextActionAt: Date;
    lastError: string;
  };

export type MarkGuestJourneyCoordinationIntentExhaustedInput =
  CompleteClaimedIntentTransitionInput & {
    lastError: string;
  };

export type MarkGuestJourneyCoordinationIntentSucceededInput = {
  intentId: string;
  outcomeEvidenceFingerprint: string;
  now: Date;
};

export type SupersedeObsoleteGuestJourneyCoordinationIntentsInput =
  {
    reservationId: string;
    activeEvidenceFingerprint: string;
    now: Date;
  };

export type GuestJourneyCoordinationIntentTransitionResult =
  {
    transitioned: boolean;
    intent: GuestJourneyCoordinationIntentSnapshot;
  };

function requireNonEmpty(
  value: string,
  fieldName: string
): string {
  const cleanValue =
    value.trim();

  if (!cleanValue) {
    throw new Error(
      `${fieldName} is required`
    );
  }

  return cleanValue;
}

function requireValidDate(
  value: Date,
  fieldName: string
): Date {
  if (
    !(value instanceof Date) ||
    Number.isNaN(value.getTime())
  ) {
    throw new Error(
      `${fieldName} must be a valid Date`
    );
  }

  return value;
}

function requireEvidenceFingerprint(
  value: string,
  fieldName:
    | "evidenceFingerprint"
    | "outcomeEvidenceFingerprint"
    | "activeEvidenceFingerprint"
): string {
  const cleanValue =
    requireNonEmpty(
      value,
      fieldName
    ).toLowerCase();

  if (
    !/^[a-f0-9]{64}$/.test(
      cleanValue
    )
  ) {
    throw new Error(
      `${fieldName} must be a SHA-256 hexadecimal fingerprint`
    );
  }

  return cleanValue;
}

function requireRegisteredIntentType(
  value: string
): GuestJourneyCoordinationIntentType {
  const cleanValue =
    requireNonEmpty(
      value,
      "intent.intentType"
    );

  if (
    !GUEST_JOURNEY_COORDINATION_INTENT_TYPES
      .some(
        (registeredType) =>
          registeredType === cleanValue
      )
  ) {
    throw new Error(
      `Unsupported Guest Journey coordination intent type: ${cleanValue}`
    );
  }

  return cleanValue as
    GuestJourneyCoordinationIntentType;
}

function requireRegisteredTargetEngine(
  value: string
): GuestJourneyTargetEngine {
  const cleanValue =
    requireNonEmpty(
      value,
      "targetEngine"
    );

  if (
    !GUEST_JOURNEY_TARGET_ENGINES
      .some(
        (registeredEngine) =>
          registeredEngine ===
          cleanValue
      )
  ) {
    throw new Error(
      `Unsupported Guest Journey target Engine: ${cleanValue}`
    );
  }

  return cleanValue as
    GuestJourneyTargetEngine;
}

function requireCode(
  value: string,
  fieldName:
    | "intent.reasonCode"
    | "intent.expectedOutcomeCode"
): string {
  const cleanValue =
    requireNonEmpty(
      value,
      fieldName
    );

  if (
    cleanValue.length > 200
  ) {
    throw new Error(
      `${fieldName} must not exceed 200 characters`
    );
  }

  if (
    !/^[A-Z0-9][A-Z0-9_.:-]*$/.test(
      cleanValue
    )
  ) {
    throw new Error(
      `${fieldName} must use a stable uppercase code`
    );
  }

  return cleanValue;
}

function requireLeaseDuration(
  leaseDurationMs:
    | number
    | undefined
): number {
  const resolvedDuration =
    leaseDurationMs ??
    DEFAULT_LEASE_DURATION_MS;

  if (
    !Number.isInteger(
      resolvedDuration
    ) ||
    resolvedDuration <
      MINIMUM_LEASE_DURATION_MS ||
    resolvedDuration >
      MAXIMUM_LEASE_DURATION_MS
  ) {
    throw new Error(
      "leaseDurationMs must be an integer between 1000 and 3600000"
    );
  }

  return resolvedDuration;
}

function normalizeError(
  value: string
): string {
  const cleanValue =
    requireNonEmpty(
      value,
      "lastError"
    );

  if (
    cleanValue.length <=
    MAXIMUM_ERROR_LENGTH
  ) {
    return cleanValue;
  }

  return cleanValue.slice(
    0,
    MAXIMUM_ERROR_LENGTH
  );
}

function normalizeJsonValue(
  value: unknown
): unknown {
  if (value instanceof Date) {
    return value.toISOString();
  }

  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (
    typeof value === "number"
  ) {
    if (!Number.isFinite(value)) {
      throw new Error(
        "Coordination intent payload numbers must be finite"
      );
    }

    return value;
  }

  if (Array.isArray(value)) {
    return value.map(
      normalizeJsonValue
    );
  }

  if (
    value &&
    typeof value === "object"
  ) {
    const normalized:
      Record<string, unknown> = {};

    for (
      const key of
      Object.keys(
        value as Record<
          string,
          unknown
        >
      ).sort()
    ) {
      const nestedValue =
        (
          value as Record<
            string,
            unknown
          >
        )[key];

      if (
        nestedValue === undefined
      ) {
        continue;
      }

      normalized[key] =
        normalizeJsonValue(
          nestedValue
        );
    }

    return normalized;
  }

  throw new Error(
    "Coordination intent payload contains an unsupported value"
  );
}

function normalizePayload(
  payload:
    | Record<string, unknown>
    | undefined
):
  | Prisma.InputJsonObject
  | undefined {
  if (payload === undefined) {
    return undefined;
  }

  return normalizeJsonValue(
    payload
  ) as Prisma.InputJsonObject;
}

function stableSerialize(
  value: unknown
): string {
  return JSON.stringify(
    normalizeJsonValue(value)
  );
}

function toSnapshot(
  record: CoordinationIntentRecord
): GuestJourneyCoordinationIntentSnapshot {
  return {
    id: record.id,
    intentKey:
      record.intentKey,

    intentType:
      requireRegisteredIntentType(
        record.intentType
      ),

    targetEngine:
      requireRegisteredTargetEngine(
        record.targetEngine
      ),

    status: record.status,

    reasonCode:
      record.reasonCode,

    expectedOutcomeCode:
      record.expectedOutcomeCode,

    evidenceFingerprint:
      record.evidenceFingerprint,

    outcomeEvidenceFingerprint:
      record
        .outcomeEvidenceFingerprint,

    claimCount:
      record.claimCount,

    leaseExpiresAt:
      record.leaseExpiresAt,

    nextActionAt:
      record.nextActionAt,

    succeededAt:
      record.succeededAt,

    exhaustedAt:
      record.exhaustedAt,

    supersededAt:
      record.supersededAt,

    lastError:
      record.lastError,
  };
}

async function readCoordinationIntent(
  tx: GuestJourneyCoordinationIntentTransactionClient,
  intentId: string
): Promise<CoordinationIntentRecord> {
  return tx
    .guestJourneyCoordinationIntent
    .findUniqueOrThrow({
      where: {
        id: intentId,
      },
      select:
        coordinationIntentSelect,
    });
}

export function buildGuestJourneyCoordinationIntentKey(
  input: EnsureGuestJourneyCoordinationIntentInput
): string {
  const reservationId =
    requireNonEmpty(
      input.reservationId,
      "reservationId"
    );

  const journeyId =
    requireNonEmpty(
      input.journeyId,
      "journeyId"
    );

  const evidenceFingerprint =
    requireEvidenceFingerprint(
      input.evidenceFingerprint,
      "evidenceFingerprint"
    );

  const intentType =
    requireRegisteredIntentType(
      input.intent.intentType
    );

  const targetEngine =
    requireRegisteredTargetEngine(
      input.intent.targetEngine
    );

  const reasonCode =
    requireCode(
      input.intent.reasonCode,
      "intent.reasonCode"
    );

  const expectedOutcomeCode =
    requireCode(
      input.intent
        .expectedOutcomeCode,
      "intent.expectedOutcomeCode"
    );

  const payload =
    normalizePayload(
      input.intent.payload
    );

  const digest =
    createHash("sha256")
      .update(
        stableSerialize({
          contractVersion:
            GUEST_JOURNEY_COORDINATION_INTENT_VERSION,
          reservationId,
          journeyId,
          evidenceFingerprint,
          intentType,
          targetEngine,
          reasonCode,
          expectedOutcomeCode,
          payload:
            payload ?? null,
        })
      )
      .digest("hex");

  return (
    "guest-journey-intent:" +
    digest
  );
}

export async function ensureGuestJourneyCoordinationIntent(
  tx: GuestJourneyCoordinationIntentTransactionClient,
  input: EnsureGuestJourneyCoordinationIntentInput
): Promise<EnsureGuestJourneyCoordinationIntentResult> {
  const reservationId =
    requireNonEmpty(
      input.reservationId,
      "reservationId"
    );

  const journeyId =
    requireNonEmpty(
      input.journeyId,
      "journeyId"
    );

  const evidenceFingerprint =
    requireEvidenceFingerprint(
      input.evidenceFingerprint,
      "evidenceFingerprint"
    );

  const intentType =
    requireRegisteredIntentType(
      input.intent.intentType
    );

  const targetEngine =
    requireRegisteredTargetEngine(
      input.intent.targetEngine
    );

  const reasonCode =
    requireCode(
      input.intent.reasonCode,
      "intent.reasonCode"
    );

  const expectedOutcomeCode =
    requireCode(
      input.intent
        .expectedOutcomeCode,
      "intent.expectedOutcomeCode"
    );

  const payload =
    normalizePayload(
      input.intent.payload
    );

  const intentKey =
    buildGuestJourneyCoordinationIntentKey(
      {
        reservationId,
        journeyId,
        evidenceFingerprint,
        intent: {
          intentType,
          targetEngine,
          reasonCode,
          expectedOutcomeCode,
          ...(payload === undefined
            ? {}
            : {
                payload:
                  payload as Record<
                    string,
                    unknown
                  >,
              }),
        },
      }
    );

  const journey =
    await tx.guestJourney
      .findUnique({
        where: {
          id: journeyId,
        },
        select: {
          id: true,
          reservationId: true,
        },
      });

  if (!journey) {
    throw new Error(
      `Cannot create coordination intent. Guest Journey ${journeyId} was not found.`
    );
  }

  if (
    journey.reservationId !==
    reservationId
  ) {
    throw new Error(
      `Guest Journey ${journeyId} does not belong to reservation ${reservationId}.`
    );
  }

  const createResult =
    await tx
      .guestJourneyCoordinationIntent
      .createMany({
        data: [
          {
            intentKey,
            reservationId,
            journeyId,

            contractVersion:
              GUEST_JOURNEY_COORDINATION_INTENT_VERSION,

            intentType,
            targetEngine,
            reasonCode,
            expectedOutcomeCode,
            evidenceFingerprint,

            ...(payload === undefined
              ? {}
              : {
                  payload,
                }),
          },
        ],
        skipDuplicates: true,
      });

  const record =
    await tx
      .guestJourneyCoordinationIntent
      .findUniqueOrThrow({
        where: {
          intentKey,
        },
        select:
          coordinationIntentSelect,
      });

  return {
    created:
      createResult.count === 1,

    intent:
      toSnapshot(record),
  };
}

export async function claimGuestJourneyCoordinationIntent(
  tx: GuestJourneyCoordinationIntentTransactionClient,
  input: ClaimGuestJourneyCoordinationIntentInput
): Promise<ClaimGuestJourneyCoordinationIntentResult> {
  const intentId =
    requireNonEmpty(
      input.intentId,
      "intentId"
    );

  const targetEngine =
    requireRegisteredTargetEngine(
      input.targetEngine
    );

  const now =
    requireValidDate(
      input.now,
      "now"
    );

  const leaseDurationMs =
    requireLeaseDuration(
      input.leaseDurationMs
    );

  const leaseToken =
    randomUUID();

  const leaseExpiresAt =
    new Date(
      now.getTime() +
        leaseDurationMs
    );

  const claimResult =
    await tx
      .guestJourneyCoordinationIntent
      .updateMany({
        where: {
          id: intentId,
          targetEngine,

          OR: [
            {
              status: {
                in: [
                  GuestJourneyCoordinationIntentStatus
                    .PENDING,

                  GuestJourneyCoordinationIntentStatus
                    .RETRYABLE,
                ],
              },

              OR: [
                {
                  nextActionAt:
                    null,
                },
                {
                  nextActionAt: {
                    lte: now,
                  },
                },
              ],
            },

            {
              status:
                GuestJourneyCoordinationIntentStatus
                  .CLAIMED,

              leaseExpiresAt: {
                lte: now,
              },
            },
          ],
        },

        data: {
          status:
            GuestJourneyCoordinationIntentStatus
              .CLAIMED,

          claimCount: {
            increment: 1,
          },

          leaseToken,
          claimedAt: now,
          leaseExpiresAt,
          lastAttemptAt: now,
          nextActionAt: null,
          lastError: null,
        },
      });

  const record =
    await readCoordinationIntent(
      tx,
      intentId
    );

  if (
    claimResult.count === 0
  ) {
    return {
      claimed: false,
      leaseToken: null,
      intent:
        toSnapshot(record),
    };
  }

  return {
    claimed: true,
    leaseToken,
    intent:
      toSnapshot(record),
  };
}

export async function markGuestJourneyCoordinationIntentWaitingForEvidence(
  tx: GuestJourneyCoordinationIntentTransactionClient,
  input: CompleteClaimedIntentTransitionInput
): Promise<GuestJourneyCoordinationIntentTransitionResult> {
  const intentId =
    requireNonEmpty(
      input.intentId,
      "intentId"
    );

  const leaseToken =
    requireNonEmpty(
      input.leaseToken,
      "leaseToken"
    );

  requireValidDate(
    input.now,
    "now"
  );

  const transitionResult =
    await tx
      .guestJourneyCoordinationIntent
      .updateMany({
        where: {
          id: intentId,

          status:
            GuestJourneyCoordinationIntentStatus
              .CLAIMED,

          leaseToken,
        },

        data: {
          status:
            GuestJourneyCoordinationIntentStatus
              .WAITING_FOR_EVIDENCE,

          leaseToken: null,
          leaseExpiresAt: null,
          nextActionAt: null,
          lastError: null,
        },
      });

  const record =
    await readCoordinationIntent(
      tx,
      intentId
    );

  return {
    transitioned:
      transitionResult.count === 1,

    intent:
      toSnapshot(record),
  };
}

export async function markGuestJourneyCoordinationIntentRetryable(
  tx: GuestJourneyCoordinationIntentTransactionClient,
  input: MarkGuestJourneyCoordinationIntentRetryableInput
): Promise<GuestJourneyCoordinationIntentTransitionResult> {
  const intentId =
    requireNonEmpty(
      input.intentId,
      "intentId"
    );

  const leaseToken =
    requireNonEmpty(
      input.leaseToken,
      "leaseToken"
    );

  const now =
    requireValidDate(
      input.now,
      "now"
    );

  const nextActionAt =
    requireValidDate(
      input.nextActionAt,
      "nextActionAt"
    );

  if (
    nextActionAt.getTime() <
    now.getTime()
  ) {
    throw new Error(
      "nextActionAt must not be earlier than now"
    );
  }

  const lastError =
    normalizeError(
      input.lastError
    );

  const transitionResult =
    await tx
      .guestJourneyCoordinationIntent
      .updateMany({
        where: {
          id: intentId,

          status:
            GuestJourneyCoordinationIntentStatus
              .CLAIMED,

          leaseToken,
        },

        data: {
          status:
            GuestJourneyCoordinationIntentStatus
              .RETRYABLE,

          leaseToken: null,
          leaseExpiresAt: null,
          nextActionAt,
          lastError,
          lastAttemptAt: now,
        },
      });

  const record =
    await readCoordinationIntent(
      tx,
      intentId
    );

  return {
    transitioned:
      transitionResult.count === 1,

    intent:
      toSnapshot(record),
  };
}

export async function markGuestJourneyCoordinationIntentSucceeded(
  tx: GuestJourneyCoordinationIntentTransactionClient,
  input: MarkGuestJourneyCoordinationIntentSucceededInput
): Promise<GuestJourneyCoordinationIntentTransitionResult> {
  const intentId =
    requireNonEmpty(
      input.intentId,
      "intentId"
    );

  const outcomeEvidenceFingerprint =
    requireEvidenceFingerprint(
      input.outcomeEvidenceFingerprint,
      "outcomeEvidenceFingerprint"
    );

  const now =
    requireValidDate(
      input.now,
      "now"
    );

  const transitionResult =
    await tx
      .guestJourneyCoordinationIntent
      .updateMany({
        where: {
          id: intentId,

          status:
            GuestJourneyCoordinationIntentStatus
              .WAITING_FOR_EVIDENCE,
        },

        data: {
          status:
            GuestJourneyCoordinationIntentStatus
              .SUCCEEDED,

          succeededAt: now,
          outcomeEvidenceFingerprint,

          leaseToken: null,
          leaseExpiresAt: null,
          nextActionAt: null,
          lastError: null,
        },
      });

  const record =
    await readCoordinationIntent(
      tx,
      intentId
    );

  return {
    transitioned:
      transitionResult.count === 1,

    intent:
      toSnapshot(record),
  };
}

export async function markGuestJourneyCoordinationIntentExhausted(
  tx: GuestJourneyCoordinationIntentTransactionClient,
  input: MarkGuestJourneyCoordinationIntentExhaustedInput
): Promise<GuestJourneyCoordinationIntentTransitionResult> {
  const intentId =
    requireNonEmpty(
      input.intentId,
      "intentId"
    );

  const leaseToken =
    requireNonEmpty(
      input.leaseToken,
      "leaseToken"
    );

  const now =
    requireValidDate(
      input.now,
      "now"
    );

  const lastError =
    normalizeError(
      input.lastError
    );

  const transitionResult =
    await tx
      .guestJourneyCoordinationIntent
      .updateMany({
        where: {
          id: intentId,

          status:
            GuestJourneyCoordinationIntentStatus
              .CLAIMED,

          leaseToken,
        },

        data: {
          status:
            GuestJourneyCoordinationIntentStatus
              .EXHAUSTED,

          exhaustedAt: now,
          lastAttemptAt: now,
          lastError,

          leaseToken: null,
          leaseExpiresAt: null,
          nextActionAt: null,
        },
      });

  const record =
    await readCoordinationIntent(
      tx,
      intentId
    );

  return {
    transitioned:
      transitionResult.count === 1,

    intent:
      toSnapshot(record),
  };
}

export async function supersedeObsoleteGuestJourneyCoordinationIntents(
  tx: GuestJourneyCoordinationIntentTransactionClient,
  input: SupersedeObsoleteGuestJourneyCoordinationIntentsInput
): Promise<number> {
  const reservationId =
    requireNonEmpty(
      input.reservationId,
      "reservationId"
    );

  const activeEvidenceFingerprint =
    requireEvidenceFingerprint(
      input.activeEvidenceFingerprint,
      "activeEvidenceFingerprint"
    );

  const now =
    requireValidDate(
      input.now,
      "now"
    );

  const result =
    await tx
      .guestJourneyCoordinationIntent
      .updateMany({
        where: {
          reservationId,

          status: {
            in: [
              ...ACTIVE_COORDINATION_INTENT_STATUSES,
            ],
          },

          evidenceFingerprint: {
            not:
              activeEvidenceFingerprint,
          },
        },

        data: {
          status:
            GuestJourneyCoordinationIntentStatus
              .SUPERSEDED,

          supersededAt: now,

          leaseToken: null,
          leaseExpiresAt: null,
          nextActionAt: null,
        },
      });

  return result.count;
}