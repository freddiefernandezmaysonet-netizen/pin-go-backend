import type { Prisma } from "@prisma/client";

import {
  createChannexAriDelivery,
  type ChannexAriDeliveryDb,
  type CreateChannexAriDeliveryInput,
} from "./channex-ari-delivery.service";

const MAX_CLAIM_TOKEN_LENGTH = 128;
const CHANNEX_ARI_FENCED_DELIVERY_SERIALIZATION_MAX_RETRIES = 2;
const CHANNEX_ARI_FENCED_DELIVERY_SERIALIZATION_RETRY_BASE_MS = 10;

type ChannexAriFencedDeliveryTransaction = Pick<
  Prisma.TransactionClient,
  "distributionOutboxEvent" | "channexAriDelivery"
>;

export type ChannexAriFencedDeliveryDb = {
  $transaction<T>(
    callback: (tx: ChannexAriFencedDeliveryTransaction) => Promise<T>,
    options?: { isolationLevel?: "Serializable" }
  ): Promise<T>;
};

export type CreateFencedChannexAriDeliveryInput = {
  claimToken: string;
  materializedAt?: Date;
  delivery: CreateChannexAriDeliveryInput;
  createDelivery?: typeof createChannexAriDelivery;
};

function requireClaimToken(value: unknown): string {
  const claimToken = String(value ?? "").trim();

  if (!claimToken) {
    throw new Error("CHANNEX_ARI_FENCED_DELIVERY_CLAIM_TOKEN_REQUIRED");
  }

  if (
    claimToken.length > MAX_CLAIM_TOKEN_LENGTH ||
    /[\u0000-\u001F\u007F\s]/.test(claimToken)
  ) {
    throw new Error("CHANNEX_ARI_FENCED_DELIVERY_CLAIM_TOKEN_INVALID");
  }

  return claimToken;
}

function requireMaterializedAt(value?: Date): Date {
  const materializedAt = value ? new Date(value) : new Date();

  if (Number.isNaN(materializedAt.getTime())) {
    throw new Error("CHANNEX_ARI_FENCED_DELIVERY_MATERIALIZED_AT_INVALID");
  }

  return materializedAt;
}

function normalizeMergedEventIds(values: string[]): string[] {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error("CHANNEX_ARI_FENCED_DELIVERY_EVENT_IDS_REQUIRED");
  }

  const eventIds = values.map((value) => {
    const eventId = String(value ?? "").trim();

    if (!eventId) {
      throw new Error("CHANNEX_ARI_FENCED_DELIVERY_EVENT_ID_INVALID");
    }

    return eventId;
  });
  const unique = Array.from(new Set(eventIds));

  if (unique.length !== eventIds.length) {
    throw new Error("CHANNEX_ARI_FENCED_DELIVERY_EVENT_ID_DUPLICATE");
  }

  return unique;
}

function requireValidExpiry(value: Date | null, materializedAt: Date): Date {
  if (!value) {
    throw new Error("CHANNEX_ARI_FENCED_DELIVERY_CLAIM_EXPIRY_REQUIRED");
  }

  const expiresAt = new Date(value);

  if (Number.isNaN(expiresAt.getTime())) {
    throw new Error("CHANNEX_ARI_FENCED_DELIVERY_CLAIM_EXPIRY_INVALID");
  }

  if (expiresAt.getTime() <= materializedAt.getTime()) {
    throw new Error("CHANNEX_ARI_FENCED_DELIVERY_CLAIM_EXPIRED");
  }

  return expiresAt;
}

function isPrismaSerializationConflict(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;

  const code =
    "code" in error && typeof error.code === "string" ? error.code : null;

  if (code === "P2034") return true;

  const message =
    "message" in error && typeof error.message === "string"
      ? error.message
      : "";

  return /transaction failed due to a write conflict or a deadlock/i.test(
    message
  );
}

async function waitForSerializationRetry(retryNumber: number) {
  const delayMs =
    CHANNEX_ARI_FENCED_DELIVERY_SERIALIZATION_RETRY_BASE_MS * retryNumber;

  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}

export async function createFencedChannexAriDelivery(
  db: ChannexAriFencedDeliveryDb,
  input: CreateFencedChannexAriDeliveryInput
) {
  const claimToken = requireClaimToken(input.claimToken);
  const materializedAt = requireMaterializedAt(input.materializedAt);
  const mergedEventIds = normalizeMergedEventIds(
    input.delivery?.plan?.mergedEventIds ?? []
  );
  const createDelivery = input.createDelivery ?? createChannexAriDelivery;

  const runTransaction = () =>
    db.$transaction(
      async (tx) => {
        const rows = await tx.distributionOutboxEvent.findMany({
          where: { id: { in: mergedEventIds } },
          orderBy: { id: "asc" },
          select: {
            id: true,
            status: true,
            claimToken: true,
            claimExpiresAt: true,
            deliveryId: true,
          },
        });

        if (rows.length !== mergedEventIds.length) {
          throw new Error("CHANNEX_ARI_FENCED_DELIVERY_EVENT_NOT_FOUND");
        }

        const rowById = new Map(rows.map((row) => [row.id, row]));
        const orderedRows = mergedEventIds.map((eventId) => rowById.get(eventId)!);
        const freshClaim = orderedRows.every(
          (row) => row.status === "CLAIMED" && !row.deliveryId
        );
        const persistedDelivery = orderedRows.every(
          (row) => row.status === "MERGED" && Boolean(row.deliveryId)
        );

        if (!freshClaim && !persistedDelivery) {
          throw new Error("CHANNEX_ARI_FENCED_DELIVERY_EVENT_STATE_CONFLICT");
        }

        if (freshClaim) {
          for (const row of orderedRows) {
            if (row.claimToken !== claimToken) {
              throw new Error("CHANNEX_ARI_FENCED_DELIVERY_CLAIM_TOKEN_MISMATCH");
            }

            requireValidExpiry(row.claimExpiresAt, materializedAt);
          }

          const fenced = await tx.distributionOutboxEvent.updateMany({
            where: {
              id: { in: mergedEventIds },
              status: "CLAIMED",
              claimToken,
              claimExpiresAt: { gt: materializedAt },
              deliveryId: null,
            },
            data: { claimToken },
          });

          if (fenced.count !== mergedEventIds.length) {
            throw new Error("CHANNEX_ARI_FENCED_DELIVERY_CLAIM_RACE");
          }
        }

        const nestedDb: ChannexAriDeliveryDb = {
          $transaction: async (callback) => callback(tx),
        };
        const result = await createDelivery(nestedDb, {
          ...input.delivery,
          queuedAt: input.delivery.queuedAt ?? materializedAt,
        });
        const cleared = await tx.distributionOutboxEvent.updateMany({
          where: {
            id: { in: mergedEventIds },
            status: "MERGED",
            deliveryId: result.delivery.id,
          },
          data: {
            claimedAt: null,
            claimToken: null,
            claimExpiresAt: null,
          },
        });

        if (cleared.count !== mergedEventIds.length) {
          throw new Error("CHANNEX_ARI_FENCED_DELIVERY_FINALIZE_RACE");
        }

        return {
          ...result,
          claimFence: {
            mode: freshClaim ? ("FRESH" as const) : ("IDEMPOTENT" as const),
            eventCount: mergedEventIds.length,
            materializedAt,
          },
        };
      },
      { isolationLevel: "Serializable" }
    );

  for (
    let retryNumber = 0;
    retryNumber <= CHANNEX_ARI_FENCED_DELIVERY_SERIALIZATION_MAX_RETRIES;
    retryNumber += 1
  ) {
    try {
      return await runTransaction();
    } catch (error) {
      if (!isPrismaSerializationConflict(error)) {
        throw error;
      }

      if (
        retryNumber ===
        CHANNEX_ARI_FENCED_DELIVERY_SERIALIZATION_MAX_RETRIES
      ) {
        throw new Error(
          "CHANNEX_ARI_FENCED_DELIVERY_SERIALIZATION_RETRY_EXHAUSTED"
        );
      }

      await waitForSerializationRetry(retryNumber + 1);
    }
  }

  throw new Error(
    "CHANNEX_ARI_FENCED_DELIVERY_SERIALIZATION_RETRY_EXHAUSTED"
  );
}
