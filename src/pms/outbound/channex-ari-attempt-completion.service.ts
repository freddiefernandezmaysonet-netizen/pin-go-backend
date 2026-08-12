import type { Prisma } from "@prisma/client";

import {
  buildChannexAriAttemptCompletion,
  type ChannexAriAttemptCompletionEvidence,
} from "./channex-ari-attempt-completion.policy";

export type ChannexAriAttemptCompletionTransaction = Pick<
  Prisma.TransactionClient,
  | "channexAriDelivery"
  | "channexAriDeliveryAttempt"
  | "channexAriPropertyState"
  | "distributionOutboxEvent"
>;

export type ChannexAriAttemptCompletionDb = {
  $transaction<T>(
    callback: (tx: ChannexAriAttemptCompletionTransaction) => Promise<T>,
    options?: { isolationLevel?: "Serializable" }
  ): Promise<T>;
};

export type CompleteChannexAriDeliveryAttemptInput = {
  deliveryId: string;
  leaseToken: string;
  evidence: ChannexAriAttemptCompletionEvidence;
  completedAt?: Date;
  jitterMs?: number;
};

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

function assertPropertyStateTenant(input: {
  state: { organizationId: string } | null;
  organizationId: string;
}): void {
  if (
    input.state &&
    input.state.organizationId !== input.organizationId
  ) {
    throw new Error("CHANNEX_ARI_COMPLETION_PROPERTY_STATE_TENANT_MISMATCH");
  }
}

function hasPropertyStateUpdate(value: Record<string, unknown>): boolean {
  return Object.keys(value).length > 0;
}

// CHANNEX_ARI_CORRELATED_FULL_SYNC_PAIR_COMPLETION_V1

type ChannexAriFullSyncPairMessageKind =
  | "AVAILABILITY"
  | "RATES_RESTRICTIONS";

function getChannexAriFullSyncSiblingMessageKind(
  messageKind: ChannexAriFullSyncPairMessageKind
): ChannexAriFullSyncPairMessageKind {
  return messageKind === "AVAILABILITY"
    ? "RATES_RESTRICTIONS"
    : "AVAILABILITY";
}

async function hasSentCorrelatedFullSyncSibling(
  tx: ChannexAriAttemptCompletionTransaction,
  input: {
    deliveryId: string;
    organizationId: string;
    propertyId: string;
    messageKind: ChannexAriFullSyncPairMessageKind;
  }
): Promise<boolean> {
  const outboxDelegate = (
    tx as ChannexAriAttemptCompletionTransaction & {
      distributionOutboxEvent?: {
        findMany?: (args: unknown) => Promise<any[]>;
      };
    }
  ).distributionOutboxEvent;

  /*
   * Some pre-existing isolated unit mocks do not yet expose the
   * outbox delegate. They cannot prove aggregate completion.
   */
  if (
    !outboxDelegate ||
    typeof outboxDelegate.findMany !== "function"
  ) {
    return false;
  }

  const currentOutboxRows =
    await outboxDelegate.findMany({
      where: {
        id: { not: "" },
        organizationId: input.organizationId,
        propertyId: input.propertyId,
        provider: "CHANNEX",
        messageKind: input.messageKind,
        syncMode: "FULL",
        status: "MERGED",
        deliveryId: input.deliveryId,
        correlationId: { not: null },
      },
      orderBy: {
        id: "asc",
      },
      take: 2,
      select: {
        correlationId: true,
      },
    });

  if (currentOutboxRows.length !== 1) {
    return false;
  }

  const correlationId =
    String(
      currentOutboxRows[0]?.correlationId ?? ""
    ).trim();

  if (!correlationId) {
    return false;
  }

  const siblingMessageKind =
    getChannexAriFullSyncSiblingMessageKind(
      input.messageKind
    );

  const siblingOutboxRows =
    await outboxDelegate.findMany({
      where: {
        organizationId: input.organizationId,
        propertyId: input.propertyId,
        provider: "CHANNEX",
        messageKind: siblingMessageKind,
        syncMode: "FULL",
        status: "MERGED",
        correlationId,
        deliveryId: { not: null },
      },
      orderBy: {
        id: "asc",
      },
      take: 2,
      select: {
        deliveryId: true,
      },
    });

  if (siblingOutboxRows.length !== 1) {
    return false;
  }

  const siblingDeliveryId =
    String(
      siblingOutboxRows[0]?.deliveryId ?? ""
    ).trim();

  if (
    !siblingDeliveryId ||
    siblingDeliveryId === input.deliveryId
  ) {
    return false;
  }

  const siblingDelivery =
    await tx.channexAriDelivery.findUnique({
      where: {
        id: siblingDeliveryId,
      },
      select: {
        id: true,
        organizationId: true,
        propertyId: true,
        messageKind: true,
        syncMode: true,
        status: true,
      },
    });

  return Boolean(
    siblingDelivery &&
      siblingDelivery.organizationId ===
        input.organizationId &&
      siblingDelivery.propertyId ===
        input.propertyId &&
      siblingDelivery.messageKind ===
        siblingMessageKind &&
      siblingDelivery.syncMode === "FULL" &&
      siblingDelivery.status === "SENT"
  );
}
export async function completeChannexAriDeliveryAttempt(
  db: ChannexAriAttemptCompletionDb,
  input: CompleteChannexAriDeliveryAttemptInput
) {
  const deliveryId = requireText(
    input.deliveryId,
    "CHANNEX_ARI_COMPLETION_DELIVERY_ID_REQUIRED"
  );
  const leaseToken = requireText(
    input.leaseToken,
    "CHANNEX_ARI_COMPLETION_LEASE_TOKEN_REQUIRED"
  );
  const completedAt = assertValidDate(
    input.completedAt,
    "CHANNEX_ARI_COMPLETION_COMPLETED_AT_INVALID"
  );

  return db.$transaction(
    async (tx) => {
      const delivery = await tx.channexAriDelivery.findUnique({
        where: { id: deliveryId },
        select: {
          id: true,
          organizationId: true,
          propertyId: true,
          messageKind: true,
          syncMode: true,
          status: true,
          attemptCount: true,
          leaseToken: true,
          leaseExpiresAt: true,
        },
      });

      if (!delivery) {
        throw new Error("CHANNEX_ARI_COMPLETION_DELIVERY_NOT_FOUND");
      }

      if (delivery.status !== "PROCESSING") {
        throw new Error("CHANNEX_ARI_COMPLETION_PROCESSING_REQUIRED");
      }

      if (!delivery.leaseExpiresAt) {
        throw new Error("CHANNEX_ARI_COMPLETION_LEASE_EXPIRES_AT_REQUIRED");
      }

      if (delivery.leaseExpiresAt.getTime() <= completedAt.getTime()) {
        throw new Error("CHANNEX_ARI_COMPLETION_LEASE_EXPIRED");
      }

      const propertyState = await tx.channexAriPropertyState.findUnique({
        where: { propertyId: delivery.propertyId },
        select: {
          organizationId: true,
          pausedUntil: true,
        },
      });

      assertPropertyStateTenant({
        state: propertyState,
        organizationId: delivery.organizationId,
      });

      const attempt = await tx.channexAriDeliveryAttempt.findUnique({
        where: {
          deliveryId_attemptNumber: {
            deliveryId: delivery.id,
            attemptNumber: delivery.attemptCount,
          },
        },
        select: {
          id: true,
          attemptNumber: true,
          outcome: true,
          startedAt: true,
          completedAt: true,
        },
      });

      if (!attempt) {
        throw new Error("CHANNEX_ARI_COMPLETION_ATTEMPT_EVIDENCE_MISSING");
      }

      const completion = buildChannexAriAttemptCompletion({
        delivery: {
          status: delivery.status,
          messageKind: delivery.messageKind,
          syncMode: delivery.syncMode,
          attemptCount: delivery.attemptCount,
          leaseToken: delivery.leaseToken ?? "",
          leaseExpiresAt: delivery.leaseExpiresAt,
        },
        attempt: {
          attemptNumber: attempt.attemptNumber,
          outcome: attempt.outcome as "IN_FLIGHT",
          startedAt: attempt.startedAt,
          completedAt: attempt.completedAt,
        },
        leaseToken,
        evidence: input.evidence,
        propertyState: propertyState ?? undefined,
        completedAt,
        jitterMs: input.jitterMs,
      });

      const completedDelivery = await tx.channexAriDelivery.updateMany({
        where: {
          id: delivery.id,
          status: "PROCESSING",
          attemptCount: delivery.attemptCount,
          leaseToken,
          leaseExpiresAt: delivery.leaseExpiresAt,
        },
        data: completion.deliveryUpdate,
      });

      if (completedDelivery.count !== 1) {
        throw new Error("CHANNEX_ARI_COMPLETION_DELIVERY_RACE");
      }

      const completedAttempt = await tx.channexAriDeliveryAttempt.updateMany({
        where: {
          id: attempt.id,
          deliveryId: delivery.id,
          attemptNumber: delivery.attemptCount,
          outcome: "IN_FLIGHT",
          completedAt: null,
        },
        data: {
          ...completion.attemptUpdate,
          responseMeta:
            completion.attemptUpdate.responseMeta as Prisma.InputJsonValue,
        },
      });

      if (completedAttempt.count !== 1) {
        throw new Error("CHANNEX_ARI_COMPLETION_ATTEMPT_RACE");
      }

      const propertyStateUpdate: Record<
        string,
        unknown
      > = {
        ...completion.propertyStateUpdate,
      };

      /*
       * A single successful FULL delivery is not an aggregate
       * Full Sync completion. The policy-level timestamp is removed
       * and restored only after the correlated sibling is SENT.
       */
      delete propertyStateUpdate.lastFullSyncCompletedAt;

      if (
        completion.retryClass === "SUCCESS" &&
        delivery.syncMode === "FULL" &&
        await hasSentCorrelatedFullSyncSibling(
          tx,
          {
            deliveryId: delivery.id,
            organizationId:
              delivery.organizationId,
            propertyId:
              delivery.propertyId,
            messageKind:
              delivery.messageKind,
          }
        )
      ) {
        propertyStateUpdate.lastFullSyncCompletedAt =
          completedAt;
      }

      if (hasPropertyStateUpdate(propertyStateUpdate)) {
        await tx.channexAriPropertyState.upsert({
          where: {
            propertyId: delivery.propertyId,
          },
          create: {
            propertyId: delivery.propertyId,
            organizationId:
              delivery.organizationId,
            ...propertyStateUpdate,
          },
          update: propertyStateUpdate,
        });
      }

      return {
        deliveryId: delivery.id,
        organizationId: delivery.organizationId,
        propertyId: delivery.propertyId,
        messageKind: delivery.messageKind,
        syncMode: delivery.syncMode,
        attemptNumber: delivery.attemptCount,
        retryClass: completion.retryClass,
        exhausted: completion.exhausted,
        retryDelayMs: completion.retryDelayMs,
        deliveryUpdate: completion.deliveryUpdate,
        attemptUpdate: completion.attemptUpdate,
        propertyStateUpdate,
      };
    },
    { isolationLevel: "Serializable" }
  );
}
