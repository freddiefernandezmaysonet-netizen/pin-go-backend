import type { Prisma } from "@prisma/client";

import {
  CHANNEX_ARI_OUTBOX_MAX_MATERIALIZATION_ATTEMPTS,
  buildChannexAriOutboxMaterializationClaim,
  buildChannexAriOutboxMaterializationFailure,
  buildChannexAriOutboxStaleClaimRecovery,
} from "./channex-ari-outbox-materialization.policy";

export const CHANNEX_ARI_OUTBOX_DEFAULT_CLAIM_BATCH_LIMIT = 100;
export const CHANNEX_ARI_OUTBOX_MAX_CLAIM_BATCH_LIMIT = 500;

const OUTBOX_EVENT_SELECT = {
  id: true,
  organizationId: true,
  propertyId: true,
  provider: true,
  messageKind: true,
  syncMode: true,
  scope: true,
  dateFrom: true,
  dateToExclusive: true,
  dateKeys: true,
  correlationId: true,
  status: true,
  availableAt: true,
  materializationAttemptCount: true,
  claimedAt: true,
  claimToken: true,
  claimExpiresAt: true,
  deliveryId: true,
  createdAt: true,
} satisfies Prisma.DistributionOutboxEventSelect;

type ChannexAriOutboxMaterializationTransaction = Pick<
  Prisma.TransactionClient,
  "distributionOutboxEvent"
>;

export type ChannexAriOutboxMaterializationDb = {
  $transaction<T>(
    callback: (
      tx: ChannexAriOutboxMaterializationTransaction
    ) => Promise<T>,
    options?: { isolationLevel?: "Serializable" }
  ): Promise<T>;
};

export type ClaimedChannexAriOutboxEvent = Prisma.DistributionOutboxEventGetPayload<{
  select: typeof OUTBOX_EVENT_SELECT;
}>;

function requireText(value: unknown, errorCode: string): string {
  const normalized = String(value ?? "").trim();

  if (!normalized) {
    throw new Error(errorCode);
  }

  return normalized;
}

function assertValidDate(value: Date | undefined, errorCode: string): Date {
  const normalized = value ? new Date(value) : new Date();

  if (Number.isNaN(normalized.getTime())) {
    throw new Error(errorCode);
  }

  return normalized;
}

function normalizeLimit(value: number | undefined): number {
  const limit =
    value === undefined
      ? CHANNEX_ARI_OUTBOX_DEFAULT_CLAIM_BATCH_LIMIT
      : Number(value);

  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > CHANNEX_ARI_OUTBOX_MAX_CLAIM_BATCH_LIMIT
  ) {
    throw new Error("CHANNEX_ARI_OUTBOX_CLAIM_BATCH_LIMIT_INVALID");
  }

  return limit;
}

function normalizeEventIds(values: string[]): string[] {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error("CHANNEX_ARI_OUTBOX_CLAIM_EVENT_IDS_REQUIRED");
  }

  const eventIds = values.map((value) =>
    requireText(value, "CHANNEX_ARI_OUTBOX_CLAIM_EVENT_ID_INVALID")
  );
  const unique = Array.from(new Set(eventIds));

  if (unique.length !== eventIds.length) {
    throw new Error("CHANNEX_ARI_OUTBOX_CLAIM_EVENT_ID_DUPLICATE");
  }

  if (unique.length > CHANNEX_ARI_OUTBOX_MAX_CLAIM_BATCH_LIMIT) {
    throw new Error("CHANNEX_ARI_OUTBOX_CLAIM_BATCH_LIMIT_EXCEEDED");
  }

  return unique;
}

function pendingEligibilityWhere(now: Date) {
  return {
    provider: "CHANNEX" as const,
    status: "PENDING" as const,
    availableAt: { lte: now },
    materializationAttemptCount: {
      lt: CHANNEX_ARI_OUTBOX_MAX_MATERIALIZATION_ATTEMPTS,
    },
    claimedAt: null,
    claimToken: null,
    claimExpiresAt: null,
    deliveryId: null,
  };
}

async function readReadySeed(
  tx: ChannexAriOutboxMaterializationTransaction,
  now: Date
): Promise<ClaimedChannexAriOutboxEvent | null> {
  const baseWhere = pendingEligibilityWhere(now);
  const orderBy = [
    { availableAt: "asc" as const },
    { createdAt: "asc" as const },
    { id: "asc" as const },
  ];
  const full = await tx.distributionOutboxEvent.findFirst({
    where: {
      ...baseWhere,
      syncMode: "FULL",
    },
    orderBy,
    select: OUTBOX_EVENT_SELECT,
  });

  if (full) return full;

  return tx.distributionOutboxEvent.findFirst({
    where: {
      ...baseWhere,
      syncMode: "INCREMENTAL",
    },
    orderBy,
    select: OUTBOX_EVENT_SELECT,
  });
}

function claimedEventFromUpdate(input: {
  event: ClaimedChannexAriOutboxEvent;
  update: ReturnType<typeof buildChannexAriOutboxMaterializationClaim>;
}): ClaimedChannexAriOutboxEvent {
  return {
    ...input.event,
    status: input.update.status,
    materializationAttemptCount:
      input.update.materializationAttemptCount,
    claimedAt: input.update.claimedAt,
    claimToken: input.update.claimToken,
    claimExpiresAt: input.update.claimExpiresAt,
  };
}

export async function claimNextChannexAriOutboxBatch(
  db: ChannexAriOutboxMaterializationDb,
  input: {
    claimToken: string;
    now?: Date;
    leaseMs?: number;
    limit?: number;
  }
) {
  const claimToken = requireText(
    input.claimToken,
    "CHANNEX_ARI_OUTBOX_CLAIM_TOKEN_REQUIRED"
  );
  const now = assertValidDate(input.now, "CHANNEX_ARI_OUTBOX_CLAIM_NOW_INVALID");
  const limit = normalizeLimit(input.limit);

  return db.$transaction(
    async (tx) => {
      const seed = await readReadySeed(tx, now);

      if (!seed) {
        return {
          claimToken: null,
          claimedAt: now,
          claimExpiresAt: null,
          events: [] as ClaimedChannexAriOutboxEvent[],
        };
      }

      const events = await tx.distributionOutboxEvent.findMany({
        where: {
          ...pendingEligibilityWhere(now),
          organizationId: seed.organizationId,
          propertyId: seed.propertyId,
          messageKind: seed.messageKind,
          syncMode: seed.syncMode,
          ...(seed.syncMode === "FULL"
            ? { correlationId: seed.correlationId }
            : {}),
        },
        orderBy: [
          { createdAt: "asc" },
          { id: "asc" },
        ],
        take: limit,
        select: OUTBOX_EVENT_SELECT,
      });

      if (events.length === 0 || !events.some((event) => event.id === seed.id)) {
        throw new Error("CHANNEX_ARI_OUTBOX_CLAIM_SEED_RACE");
      }

      const claimedEvents: ClaimedChannexAriOutboxEvent[] = [];

      for (const event of events) {
        const update = buildChannexAriOutboxMaterializationClaim({
          state: event,
          claimToken,
          claimedAt: now,
          leaseMs: input.leaseMs,
        });
        const claimed = await tx.distributionOutboxEvent.updateMany({
          where: {
            id: event.id,
            provider: "CHANNEX",
            status: "PENDING",
            availableAt: event.availableAt,
            materializationAttemptCount:
              event.materializationAttemptCount,
            claimedAt: null,
            claimToken: null,
            claimExpiresAt: null,
            deliveryId: null,
          },
          data: update,
        });

        if (claimed.count !== 1) {
          throw new Error("CHANNEX_ARI_OUTBOX_CLAIM_RACE");
        }

        claimedEvents.push(claimedEventFromUpdate({ event, update }));
      }

      return {
        claimToken,
        claimedAt: now,
        claimExpiresAt: claimedEvents[0].claimExpiresAt,
        events: claimedEvents,
      };
    },
    { isolationLevel: "Serializable" }
  );
}

export async function failClaimedChannexAriOutboxBatch(
  db: ChannexAriOutboxMaterializationDb,
  input: {
    eventIds: string[];
    claimToken: string;
    failedAt?: Date;
    errorCode: string;
    errorSummary?: string | null;
    terminal?: boolean;
    retryAfterMs?: number | null;
    jitterMs?: number;
  }
) {
  const eventIds = normalizeEventIds(input.eventIds);
  const claimToken = requireText(
    input.claimToken,
    "CHANNEX_ARI_OUTBOX_CLAIM_TOKEN_REQUIRED"
  );
  const failedAt = assertValidDate(
    input.failedAt,
    "CHANNEX_ARI_OUTBOX_FAILURE_NOW_INVALID"
  );

  return db.$transaction(
    async (tx) => {
      const events = await tx.distributionOutboxEvent.findMany({
        where: {
          id: { in: eventIds },
          provider: "CHANNEX",
          status: "CLAIMED",
          claimToken,
          deliveryId: null,
        },
        orderBy: { id: "asc" },
        select: OUTBOX_EVENT_SELECT,
      });

      if (events.length !== eventIds.length) {
        throw new Error("CHANNEX_ARI_OUTBOX_FAILURE_CLAIM_NOT_FOUND");
      }

      let pendingCount = 0;
      let deadCount = 0;

      for (const event of events) {
        const update = buildChannexAriOutboxMaterializationFailure({
          state: event,
          claimToken,
          failedAt,
          errorCode: input.errorCode,
          errorSummary: input.errorSummary,
          terminal: input.terminal,
          retryAfterMs: input.retryAfterMs,
          jitterMs: input.jitterMs,
        });
        const failed = await tx.distributionOutboxEvent.updateMany({
          where: {
            id: event.id,
            status: "CLAIMED",
            materializationAttemptCount:
              event.materializationAttemptCount,
            claimToken,
            claimExpiresAt: event.claimExpiresAt,
            deliveryId: null,
          },
          data: update,
        });

        if (failed.count !== 1) {
          throw new Error("CHANNEX_ARI_OUTBOX_FAILURE_RACE");
        }

        if (update.status === "DEAD") deadCount += 1;
        else pendingCount += 1;
      }

      return {
        eventCount: events.length,
        pendingCount,
        deadCount,
      };
    },
    { isolationLevel: "Serializable" }
  );
}

export async function recoverStaleChannexAriOutboxClaims(
  db: ChannexAriOutboxMaterializationDb,
  input: {
    now?: Date;
    limit?: number;
    jitterMs?: number;
  } = {}
) {
  const now = assertValidDate(
    input.now,
    "CHANNEX_ARI_OUTBOX_RECOVERY_NOW_INVALID"
  );
  const limit = normalizeLimit(input.limit);

  return db.$transaction(
    async (tx) => {
      const events = await tx.distributionOutboxEvent.findMany({
        where: {
          provider: "CHANNEX",
          status: "CLAIMED",
          claimExpiresAt: { lte: now },
          claimToken: { not: null },
          deliveryId: null,
        },
        orderBy: [
          { claimExpiresAt: "asc" },
          { id: "asc" },
        ],
        take: limit,
        select: OUTBOX_EVENT_SELECT,
      });
      let pendingCount = 0;
      let deadCount = 0;

      for (const event of events) {
        const update = buildChannexAriOutboxStaleClaimRecovery({
          state: event,
          recoveredAt: now,
          jitterMs: input.jitterMs,
        });
        const recovered = await tx.distributionOutboxEvent.updateMany({
          where: {
            id: event.id,
            status: "CLAIMED",
            materializationAttemptCount:
              event.materializationAttemptCount,
            claimToken: event.claimToken,
            claimExpiresAt: event.claimExpiresAt,
            deliveryId: null,
          },
          data: update,
        });

        if (recovered.count !== 1) {
          throw new Error("CHANNEX_ARI_OUTBOX_RECOVERY_RACE");
        }

        if (update.status === "DEAD") deadCount += 1;
        else pendingCount += 1;
      }

      return {
        recoveredCount: events.length,
        pendingCount,
        deadCount,
      };
    },
    { isolationLevel: "Serializable" }
  );
}
