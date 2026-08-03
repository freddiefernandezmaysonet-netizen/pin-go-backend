import type { Prisma } from "@prisma/client";

import {
  buildChannexAriDispatchClaim,
  buildChannexAriStaleLeaseRecovery,
} from "./channex-ari-dispatch.policy";

type ChannexAriDispatchTransaction = Pick<
  Prisma.TransactionClient,
  | "channexAriDelivery"
  | "channexAriDeliveryAttempt"
  | "channexAriPropertyState"
>;

export type ChannexAriDispatchDb = {
  $transaction<T>(
    callback: (tx: ChannexAriDispatchTransaction) => Promise<T>,
    options?: { isolationLevel?: "Serializable" }
  ): Promise<T>;
};

export type ClaimChannexAriDeliveryInput = {
  deliveryId: string;
  leaseToken: string;
  now?: Date;
  leaseMs?: number;
};

export type RecoverStaleChannexAriDeliveryInput = {
  deliveryId: string;
  now?: Date;
  jitterMs?: number;
};

function requireText(value: unknown, errorCode: string): string {
  const normalized = String(value ?? "").trim();

  if (!normalized) {
    throw new Error(errorCode);
  }

  return normalized;
}

function assertValidNow(value?: Date): Date {
  const now = value ? new Date(value) : new Date();

  if (Number.isNaN(now.getTime())) {
    throw new Error("CHANNEX_ARI_DISPATCH_NOW_INVALID");
  }

  return now;
}

function laterDate(left: Date | null, right: Date): Date {
  if (!left) return right;
  return left.getTime() >= right.getTime() ? left : right;
}

function assertPropertyStateTenant(input: {
  state: { organizationId: string } | null;
  organizationId: string;
}): void {
  if (
    input.state &&
    input.state.organizationId !== input.organizationId
  ) {
    throw new Error("CHANNEX_ARI_PROPERTY_STATE_TENANT_MISMATCH");
  }
}

export async function claimChannexAriDelivery(
  db: ChannexAriDispatchDb,
  input: ClaimChannexAriDeliveryInput
) {
  const deliveryId = requireText(
    input.deliveryId,
    "CHANNEX_ARI_DELIVERY_ID_REQUIRED"
  );
  const leaseToken = requireText(
    input.leaseToken,
    "CHANNEX_ARI_LEASE_TOKEN_REQUIRED"
  );
  const now = assertValidNow(input.now);

  return db.$transaction(
    async (tx) => {
      const delivery = await tx.channexAriDelivery.findUnique({
        where: { id: deliveryId },
        select: {
          id: true,
          organizationId: true,
          propertyId: true,
          connectionId: true,
          listingId: true,
          messageKind: true,
          status: true,
          payload: true,
          payloadHash: true,
          payloadValueCount: true,
          payloadBytes: true,
          attemptCount: true,
          nextAttemptAt: true,
          leaseToken: true,
          leaseExpiresAt: true,
        },
      });

      if (!delivery) {
        throw new Error("CHANNEX_ARI_DISPATCH_DELIVERY_NOT_FOUND");
      }

      const propertyState = await tx.channexAriPropertyState.findUnique({
        where: { propertyId: delivery.propertyId },
        select: {
          organizationId: true,
          pausedUntil: true,
          availabilityNextAllowedAt: true,
          ratesNextAllowedAt: true,
        },
      });

      assertPropertyStateTenant({
        state: propertyState,
        organizationId: delivery.organizationId,
      });

      const claim = buildChannexAriDispatchClaim({
        delivery: {
          status: delivery.status,
          messageKind: delivery.messageKind,
          attemptCount: delivery.attemptCount,
          nextAttemptAt: delivery.nextAttemptAt,
          leaseToken: delivery.leaseToken,
          leaseExpiresAt: delivery.leaseExpiresAt,
        },
        propertyState: propertyState ?? undefined,
        now,
        leaseToken,
        leaseMs: input.leaseMs,
      });

      const claimed = await tx.channexAriDelivery.updateMany({
        where: {
          id: delivery.id,
          status: delivery.status,
          attemptCount: delivery.attemptCount,
          nextAttemptAt: delivery.nextAttemptAt,
          leaseToken: null,
          leaseExpiresAt: null,
        },
        data: claim.deliveryUpdate,
      });

      if (claimed.count !== 1) {
        throw new Error("CHANNEX_ARI_DISPATCH_CLAIM_RACE");
      }

      const attempt = await tx.channexAriDeliveryAttempt.create({
        data: {
          deliveryId: delivery.id,
          ...claim.attemptCreate,
        },
      });

      await tx.channexAriPropertyState.upsert({
        where: { propertyId: delivery.propertyId },
        create: {
          propertyId: delivery.propertyId,
          organizationId: delivery.organizationId,
          ...claim.propertyStateUpdate,
        },
        update: claim.propertyStateUpdate,
      });

      return {
        delivery: {
          id: delivery.id,
          organizationId: delivery.organizationId,
          propertyId: delivery.propertyId,
          connectionId: delivery.connectionId,
          listingId: delivery.listingId,
          messageKind: delivery.messageKind,
          status: claim.deliveryUpdate.status,
          payload: delivery.payload,
          payloadHash: delivery.payloadHash,
          payloadValueCount: delivery.payloadValueCount,
          payloadBytes: delivery.payloadBytes,
          attemptCount: claim.deliveryUpdate.attemptCount,
          leaseToken: claim.deliveryUpdate.leaseToken,
          leaseExpiresAt: claim.deliveryUpdate.leaseExpiresAt,
        },
        attempt,
      };
    },
    { isolationLevel: "Serializable" }
  );
}

export async function recoverStaleChannexAriDeliveryLease(
  db: ChannexAriDispatchDb,
  input: RecoverStaleChannexAriDeliveryInput
) {
  const deliveryId = requireText(
    input.deliveryId,
    "CHANNEX_ARI_DELIVERY_ID_REQUIRED"
  );
  const now = assertValidNow(input.now);

  return db.$transaction(
    async (tx) => {
      const delivery = await tx.channexAriDelivery.findUnique({
        where: { id: deliveryId },
        select: {
          id: true,
          organizationId: true,
          propertyId: true,
          messageKind: true,
          status: true,
          attemptCount: true,
          nextAttemptAt: true,
          leaseToken: true,
          leaseExpiresAt: true,
        },
      });

      if (!delivery) {
        throw new Error("CHANNEX_ARI_DISPATCH_DELIVERY_NOT_FOUND");
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
          outcome: true,
          startedAt: true,
          completedAt: true,
        },
      });

      if (!attempt) {
        throw new Error("CHANNEX_ARI_STALE_ATTEMPT_EVIDENCE_MISSING");
      }

      if (attempt.outcome !== "IN_FLIGHT" || attempt.completedAt) {
        throw new Error("CHANNEX_ARI_STALE_ATTEMPT_STATE_INVALID");
      }

      const recovery = buildChannexAriStaleLeaseRecovery({
        delivery: {
          status: delivery.status,
          messageKind: delivery.messageKind,
          attemptCount: delivery.attemptCount,
          nextAttemptAt: delivery.nextAttemptAt,
          leaseToken: delivery.leaseToken,
          leaseExpiresAt: delivery.leaseExpiresAt,
        },
        now,
        jitterMs: input.jitterMs,
      });

      const recoveredDelivery = await tx.channexAriDelivery.updateMany({
        where: {
          id: delivery.id,
          status: "PROCESSING",
          attemptCount: delivery.attemptCount,
          leaseToken: delivery.leaseToken,
          leaseExpiresAt: delivery.leaseExpiresAt,
        },
        data: recovery.deliveryUpdate,
      });

      if (recoveredDelivery.count !== 1) {
        throw new Error("CHANNEX_ARI_STALE_DELIVERY_RECOVERY_RACE");
      }

      const durationMs = Math.max(
        0,
        now.getTime() - attempt.startedAt.getTime()
      );
      const recoveredAttempt = await tx.channexAriDeliveryAttempt.updateMany({
        where: {
          id: attempt.id,
          outcome: "IN_FLIGHT",
          completedAt: null,
        },
        data: {
          ...recovery.attemptUpdate,
          durationMs,
        },
      });

      if (recoveredAttempt.count !== 1) {
        throw new Error("CHANNEX_ARI_STALE_ATTEMPT_RECOVERY_RACE");
      }

      const pausedUntil = laterDate(
        propertyState?.pausedUntil ?? null,
        recovery.propertyStateUpdate.pausedUntil
      );

      await tx.channexAriPropertyState.upsert({
        where: { propertyId: delivery.propertyId },
        create: {
          propertyId: delivery.propertyId,
          organizationId: delivery.organizationId,
          pausedUntil,
        },
        update: {
          pausedUntil,
        },
      });

      return {
        deliveryId: delivery.id,
        attemptNumber: delivery.attemptCount,
        exhausted: recovery.exhausted,
        retryDelayMs: recovery.retryDelayMs,
        deliveryUpdate: recovery.deliveryUpdate,
        attemptUpdate: {
          ...recovery.attemptUpdate,
          durationMs,
        },
        propertyStateUpdate: {
          pausedUntil,
        },
      };
    },
    { isolationLevel: "Serializable" }
  );
}
