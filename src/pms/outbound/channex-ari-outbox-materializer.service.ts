import crypto from "node:crypto";
import type { Prisma } from "@prisma/client";

import {
  buildChannexAriCoalescingPlan,
  type ChannexAriCoalescingEvent,
} from "./channex-ari-coalescing.policy";
import {
  createFencedChannexAriDelivery,
  type ChannexAriFencedDeliveryDb,
} from "./channex-ari-fenced-delivery.service";
import {
  resolveChannexAriMapping,
  type ChannexAriMappingDb,
} from "./channex-ari-mapping.service";
import {
  CHANNEX_ARI_OUTBOX_DEFAULT_CLAIM_BATCH_LIMIT,
  claimNextChannexAriOutboxBatch,
  failClaimedChannexAriOutboxBatch,
  recoverStaleChannexAriOutboxClaims,
  type ChannexAriOutboxMaterializationDb,
} from "./channex-ari-outbox-materialization.service";
import {
  readChannexAriSnapshot,
  type ChannexAriSnapshotDb,
} from "./channex-ari-snapshot.service";

export const CHANNEX_ARI_MAX_FULL_SUPERSESSION_EVENTS = 5_000;

export type ChannexAriOutboxMaterializerDb = Pick<
  Prisma.TransactionClient,
  | "distributionOutboxEvent"
  | "property"
  | "pmsConnection"
  | "pmsListing"
  | "reservation"
  | "propertyBlockedDate"
> & {
  $transaction<T>(
    callback: (tx: Prisma.TransactionClient) => Promise<T>,
    options?: { isolationLevel?: "Serializable" }
  ): Promise<T>;
};

export type MaterializeNextChannexAriOutboxBatchInput = {
  db: ChannexAriOutboxMaterializerDb;
  now?: Date;
  claimLeaseMs?: number;
  claimLimit?: number;
  recoveryLimit?: number;
  jitterMs?: number;
  claimTokenFactory?: () => string;
  claim?: typeof claimNextChannexAriOutboxBatch;
  recover?: typeof recoverStaleChannexAriOutboxClaims;
  buildPlan?: typeof buildChannexAriCoalescingPlan;
  resolveMapping?: typeof resolveChannexAriMapping;
  readSnapshot?: typeof readChannexAriSnapshot;
  createDelivery?: typeof createFencedChannexAriDelivery;
  failClaim?: typeof failClaimedChannexAriOutboxBatch;
  clock?: () => Date;
};

function readClock(
  value: Date | undefined,
  clock: (() => Date) | undefined,
  errorCode: string
): Date {
  const instant = value ? new Date(value) : new Date(clock ? clock() : new Date());

  if (Number.isNaN(instant.getTime())) {
    throw new Error(errorCode);
  }

  return instant;
}

function requireClaimToken(factory?: () => string): string {
  const claimToken = String(factory ? factory() : crypto.randomUUID()).trim();

  if (
    !claimToken ||
    claimToken.length > 128 ||
    /[\u0000-\u001F\u007F\s]/.test(claimToken)
  ) {
    throw new Error("CHANNEX_ARI_OUTBOX_MATERIALIZER_CLAIM_TOKEN_INVALID");
  }

  return claimToken;
}

function publicErrorCode(error: unknown): string {
  const message =
    error instanceof Error ? String(error.message ?? "").trim() : "";

  return /^[A-Z0-9_]+$/.test(message) && message.length <= 128
    ? message
    : "CHANNEX_ARI_OUTBOX_MATERIALIZATION_FAILED";
}

function toDatabaseDate(dateKey: string): Date {
  return new Date(`${dateKey}T00:00:00.000Z`);
}

async function readCoveredPendingIncrementalIds(input: {
  db: ChannexAriOutboxMaterializerDb;
  plan: ReturnType<typeof buildChannexAriCoalescingPlan>;
}): Promise<string[]> {
  if (input.plan.syncMode !== "FULL") return [];

  const rows = await input.db.distributionOutboxEvent.findMany({
    where: {
      organizationId: input.plan.organizationId,
      propertyId: input.plan.propertyId,
      provider: "CHANNEX",
      messageKind: input.plan.messageKind,
      syncMode: "INCREMENTAL",
      status: "PENDING",
      claimedAt: null,
      claimToken: null,
      claimExpiresAt: null,
      deliveryId: null,
      createdAt: { lte: input.plan.snapshotAt },
      dateFrom: { gte: toDatabaseDate(input.plan.dateFrom) },
      dateToExclusive: {
        lte: toDatabaseDate(input.plan.dateToExclusive),
      },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: CHANNEX_ARI_MAX_FULL_SUPERSESSION_EVENTS + 1,
    select: { id: true },
  });

  if (rows.length > CHANNEX_ARI_MAX_FULL_SUPERSESSION_EVENTS) {
    throw new Error("CHANNEX_ARI_FULL_SUPERSESSION_LIMIT_EXCEEDED");
  }

  return rows.map((row) => row.id);
}

export async function materializeNextChannexAriOutboxBatch(
  input: MaterializeNextChannexAriOutboxBatchInput
) {
  const startedAt = readClock(
    input.now,
    input.clock,
    "CHANNEX_ARI_OUTBOX_MATERIALIZER_NOW_INVALID"
  );
  const claimToken = requireClaimToken(input.claimTokenFactory);
  const recover = input.recover ?? recoverStaleChannexAriOutboxClaims;
  const claim = input.claim ?? claimNextChannexAriOutboxBatch;
  const buildPlan = input.buildPlan ?? buildChannexAriCoalescingPlan;
  const resolveMapping = input.resolveMapping ?? resolveChannexAriMapping;
  const readSnapshot = input.readSnapshot ?? readChannexAriSnapshot;
  const createDelivery = input.createDelivery ?? createFencedChannexAriDelivery;
  const failClaim = input.failClaim ?? failClaimedChannexAriOutboxBatch;
  const recovery = await recover(
    input.db as unknown as ChannexAriOutboxMaterializationDb,
    {
      now: startedAt,
      limit: input.recoveryLimit ?? input.claimLimit,
      jitterMs: input.jitterMs,
    }
  );
  const claimed = await claim(
    input.db as unknown as ChannexAriOutboxMaterializationDb,
    {
      claimToken,
      now: startedAt,
      leaseMs: input.claimLeaseMs,
      limit: input.claimLimit ?? CHANNEX_ARI_OUTBOX_DEFAULT_CLAIM_BATCH_LIMIT,
    }
  );

  if (claimed.events.length === 0) {
    return {
      outcome: "EMPTY" as const,
      startedAt,
      recovery,
      claimedCount: 0,
    };
  }

  const eventIds = claimed.events.map((event) => event.id);

  try {
    const plan = buildPlan({
      events: claimed.events as unknown as ChannexAriCoalescingEvent[],
      snapshotAt: startedAt,
    });
    const mapping = await resolveMapping(
      input.db as unknown as ChannexAriMappingDb,
      {
        organizationId: plan.organizationId,
        propertyId: plan.propertyId,
      }
    );
    const snapshot = await readSnapshot(
      input.db as unknown as ChannexAriSnapshotDb,
      { plan, mapping }
    );
    const supersededEventIds = await readCoveredPendingIncrementalIds({
      db: input.db,
      plan,
    });
    const materializedAt = readClock(
      undefined,
      input.clock,
      "CHANNEX_ARI_OUTBOX_MATERIALIZER_COMPLETED_AT_INVALID"
    );
    const delivery = await createDelivery(
      input.db as unknown as ChannexAriFencedDeliveryDb,
      {
        claimToken,
        materializedAt,
        delivery: {
          plan,
          mapping,
          snapshot,
          supersededEventIds,
          queuedAt: materializedAt,
        },
      }
    );

    return {
      outcome: "MATERIALIZED" as const,
      startedAt,
      materializedAt,
      recovery,
      claimedCount: claimed.events.length,
      supersededCount: supersededEventIds.length,
      delivery,
    };
  } catch (error) {
    const errorCode = publicErrorCode(error);
    const failedAt = readClock(
      undefined,
      input.clock,
      "CHANNEX_ARI_OUTBOX_MATERIALIZER_FAILED_AT_INVALID"
    );

    try {
      const release = await failClaim(
        input.db as unknown as ChannexAriOutboxMaterializationDb,
        {
          eventIds,
          claimToken,
          failedAt,
          errorCode,
          jitterMs: input.jitterMs,
        }
      );

      return {
        outcome: "FAILED" as const,
        startedAt,
        failedAt,
        recovery,
        claimedCount: claimed.events.length,
        errorCode,
        release: {
          released: true as const,
          ...release,
        },
      };
    } catch (releaseError) {
      return {
        outcome: "FAILED" as const,
        startedAt,
        failedAt,
        recovery,
        claimedCount: claimed.events.length,
        errorCode,
        release: {
          released: false as const,
          errorCode: publicErrorCode(releaseError),
        },
      };
    }
  }
}
