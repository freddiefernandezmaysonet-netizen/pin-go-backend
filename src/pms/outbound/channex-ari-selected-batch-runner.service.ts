import crypto from "node:crypto";
import type { Prisma } from "@prisma/client";

import type { ChannexAriAttemptCompletionDb } from "./channex-ari-attempt-completion.service";
import {
  resolveChannexAriCredentials,
  type ChannexAriCredentialsDb,
} from "./channex-ari-credentials.service";
import {
  claimChannexAriDelivery,
  recoverStaleChannexAriDeliveryLease,
  type ChannexAriDispatchDb,
} from "./channex-ari-dispatch.service";
import {
  executeClaimedChannexAriDelivery,
  type ClaimedChannexAriDelivery,
} from "./channex-ari-delivery-executor.service";
import type { ChannexAriHttpTransport } from "./channex-ari-http.client";
import {
  CHANNEX_ARI_MAX_SELECTION_LIMIT,
  type ChannexAriJobSelectionAction,
} from "./channex-ari-job-selection.policy";

export type ChannexAriSelectedBatchRunnerDb =
  Pick<Prisma.TransactionClient, "channexAriDelivery"> &
  ChannexAriCredentialsDb &
  ChannexAriDispatchDb &
  ChannexAriAttemptCompletionDb;

export type ChannexAriSelectedBatchFailurePhase =
  | "RECOVER_STALE_LEASE"
  | "PREFLIGHT"
  | "CLAIM"
  | "EXECUTE";

export type RunSelectedChannexAriBatchInput = {
  db: ChannexAriSelectedBatchRunnerDb;
  actions: ChannexAriJobSelectionAction[];
  credentialsSecret?: string;
  globalApiKey?: string;
  baseUrl?: string;
  timeoutMs?: number;
  jitterMs?: number;
  leaseMs?: number;
  completionReserveMs?: number;
  transport?: ChannexAriHttpTransport;
  clock?: () => Date;
  leaseTokenFactory?: (
    action: ChannexAriJobSelectionAction,
    index: number
  ) => string;
  resolveCredentials?: typeof resolveChannexAriCredentials;
  claim?: typeof claimChannexAriDelivery;
  recover?: typeof recoverStaleChannexAriDeliveryLease;
  execute?: typeof executeClaimedChannexAriDelivery;
};

type NormalizedAction = ChannexAriJobSelectionAction & {
  readyAt: Date;
};

type ClaimPreflight = {
  id: string;
  organizationId: string;
  propertyId: string;
  connectionId: string;
  messageKind: "AVAILABILITY" | "RATES_RESTRICTIONS";
  status: "READY" | "RETRY_WAIT";
  attemptCount: number;
};

function requireText(value: unknown, errorCode: string): string {
  const normalized = String(value ?? "").trim();

  if (!normalized) {
    throw new Error(errorCode);
  }

  return normalized;
}

function assertValidDate(value: Date, errorCode: string): Date {
  const normalized = new Date(value);

  if (Number.isNaN(normalized.getTime())) {
    throw new Error(errorCode);
  }

  return normalized;
}

function readClock(clock: (() => Date) | undefined): Date {
  return assertValidDate(
    clock ? clock() : new Date(),
    "CHANNEX_ARI_BATCH_RUNNER_CLOCK_INVALID"
  );
}

function normalizeAction(
  action: ChannexAriJobSelectionAction,
  index: number
): NormalizedAction {
  if (!action || typeof action !== "object" || Array.isArray(action)) {
    throw new Error(`CHANNEX_ARI_BATCH_ACTION_${index}_INVALID`);
  }

  const deliveryId = requireText(
    action.deliveryId,
    `CHANNEX_ARI_BATCH_ACTION_${index}_DELIVERY_ID_REQUIRED`
  );
  const organizationId = requireText(
    action.organizationId,
    `CHANNEX_ARI_BATCH_ACTION_${index}_ORGANIZATION_ID_REQUIRED`
  );
  const propertyId = requireText(
    action.propertyId,
    `CHANNEX_ARI_BATCH_ACTION_${index}_PROPERTY_ID_REQUIRED`
  );

  if (
    action.messageKind !== "AVAILABILITY" &&
    action.messageKind !== "RATES_RESTRICTIONS"
  ) {
    throw new Error(`CHANNEX_ARI_BATCH_ACTION_${index}_MESSAGE_KIND_INVALID`);
  }

  if (action.action !== "CLAIM" && action.action !== "RECOVER_STALE_LEASE") {
    throw new Error(`CHANNEX_ARI_BATCH_ACTION_${index}_KIND_INVALID`);
  }

  if (!Number.isSafeInteger(action.attemptCount) || action.attemptCount < 0) {
    throw new Error(`CHANNEX_ARI_BATCH_ACTION_${index}_ATTEMPT_COUNT_INVALID`);
  }

  const partitionKey = requireText(
    action.partitionKey,
    `CHANNEX_ARI_BATCH_ACTION_${index}_PARTITION_KEY_REQUIRED`
  );
  const expectedPartitionKey = `${propertyId}:${action.messageKind}`;

  if (partitionKey !== expectedPartitionKey) {
    throw new Error(`CHANNEX_ARI_BATCH_ACTION_${index}_PARTITION_MISMATCH`);
  }

  return {
    ...action,
    deliveryId,
    organizationId,
    propertyId,
    partitionKey,
    readyAt: assertValidDate(
      action.readyAt,
      `CHANNEX_ARI_BATCH_ACTION_${index}_READY_AT_INVALID`
    ),
  };
}

function normalizeActions(
  actions: ChannexAriJobSelectionAction[]
): NormalizedAction[] {
  if (!Array.isArray(actions)) {
    throw new Error("CHANNEX_ARI_BATCH_ACTIONS_REQUIRED");
  }

  if (actions.length > CHANNEX_ARI_MAX_SELECTION_LIMIT) {
    throw new Error("CHANNEX_ARI_BATCH_ACTION_LIMIT_EXCEEDED");
  }

  const normalized = actions.map(normalizeAction);
  const deliveryIds = new Set<string>();
  const partitions = new Set<string>();

  for (const action of normalized) {
    if (deliveryIds.has(action.deliveryId)) {
      throw new Error("CHANNEX_ARI_BATCH_DUPLICATE_DELIVERY_ID");
    }

    if (partitions.has(action.partitionKey)) {
      throw new Error("CHANNEX_ARI_BATCH_DUPLICATE_PARTITION");
    }

    deliveryIds.add(action.deliveryId);
    partitions.add(action.partitionKey);
  }

  return normalized;
}

function publicErrorCode(error: unknown): string {
  const message =
    error instanceof Error ? String(error.message ?? "").trim() : "";

  return /^[A-Z0-9_]+$/.test(message) && message.length <= 128
    ? message
    : "CHANNEX_ARI_BATCH_ACTION_FAILED";
}

function createLeaseToken(input: {
  factory:
    | ((action: ChannexAriJobSelectionAction, index: number) => string)
    | undefined;
  action: ChannexAriJobSelectionAction;
  index: number;
}): string {
  const token = input.factory
    ? input.factory(input.action, input.index)
    : crypto.randomUUID();

  return requireText(token, "CHANNEX_ARI_BATCH_LEASE_TOKEN_REQUIRED");
}

async function readClaimPreflight(
  db: ChannexAriSelectedBatchRunnerDb,
  action: NormalizedAction
): Promise<ClaimPreflight> {
  const delivery = await db.channexAriDelivery.findUnique({
    where: { id: action.deliveryId },
    select: {
      id: true,
      organizationId: true,
      propertyId: true,
      connectionId: true,
      messageKind: true,
      status: true,
      attemptCount: true,
      leaseToken: true,
      leaseExpiresAt: true,
    },
  });

  if (!delivery) {
    throw new Error("CHANNEX_ARI_BATCH_DELIVERY_NOT_FOUND");
  }

  if (delivery.organizationId !== action.organizationId) {
    throw new Error("CHANNEX_ARI_BATCH_ORGANIZATION_MISMATCH");
  }

  if (delivery.propertyId !== action.propertyId) {
    throw new Error("CHANNEX_ARI_BATCH_PROPERTY_MISMATCH");
  }

  if (delivery.messageKind !== action.messageKind) {
    throw new Error("CHANNEX_ARI_BATCH_MESSAGE_KIND_MISMATCH");
  }

  if (delivery.attemptCount !== action.attemptCount) {
    throw new Error("CHANNEX_ARI_BATCH_ATTEMPT_COUNT_MISMATCH");
  }

  if (delivery.status !== "READY" && delivery.status !== "RETRY_WAIT") {
    throw new Error("CHANNEX_ARI_BATCH_CLAIM_STATUS_INVALID");
  }

  if (delivery.leaseToken || delivery.leaseExpiresAt) {
    throw new Error("CHANNEX_ARI_BATCH_CLAIM_LEASE_PRESENT");
  }

  return {
    id: delivery.id,
    organizationId: delivery.organizationId,
    propertyId: delivery.propertyId,
    connectionId: delivery.connectionId,
    messageKind: delivery.messageKind,
    status: delivery.status,
    attemptCount: delivery.attemptCount,
  };
}

function assertClaimMatchesPreflight(input: {
  claimed: ClaimedChannexAriDelivery;
  preflight: ClaimPreflight;
}): void {
  if (
    input.claimed.id !== input.preflight.id ||
    input.claimed.organizationId !== input.preflight.organizationId ||
    input.claimed.propertyId !== input.preflight.propertyId ||
    input.claimed.connectionId !== input.preflight.connectionId ||
    input.claimed.messageKind !== input.preflight.messageKind ||
    input.claimed.attemptCount !== input.preflight.attemptCount + 1
  ) {
    throw new Error("CHANNEX_ARI_BATCH_CLAIM_RESULT_MISMATCH");
  }
}

export async function runSelectedChannexAriBatch(
  input: RunSelectedChannexAriBatchInput
) {
  const actions = normalizeActions(input.actions);
  const resolveCredentials =
    input.resolveCredentials ?? resolveChannexAriCredentials;
  const claim = input.claim ?? claimChannexAriDelivery;
  const recover = input.recover ?? recoverStaleChannexAriDeliveryLease;
  const execute = input.execute ?? executeClaimedChannexAriDelivery;
  const results: Array<Record<string, unknown>> = [];

  for (const [index, action] of actions.entries()) {
    let phase: ChannexAriSelectedBatchFailurePhase =
      action.action === "RECOVER_STALE_LEASE"
        ? "RECOVER_STALE_LEASE"
        : "PREFLIGHT";
    let claimedDelivery: ClaimedChannexAriDelivery | null = null;

    try {
      if (action.action === "RECOVER_STALE_LEASE") {
        const recoveredAt = readClock(input.clock);
        const recovery = await recover(input.db, {
          deliveryId: action.deliveryId,
          now: recoveredAt,
          jitterMs: input.jitterMs,
        });

        results.push({
          action,
          outcome: "RECOVERED",
          recoveredAt,
          recovery,
        });
        continue;
      }

      const preflight = await readClaimPreflight(input.db, action);
      const credentials = await resolveCredentials(input.db, {
        connectionId: preflight.connectionId,
        organizationId: preflight.organizationId,
        credentialsSecret: input.credentialsSecret,
        globalApiKey: input.globalApiKey,
      });

      phase = "CLAIM";
      const claimedAt = readClock(input.clock);
      const leaseToken = createLeaseToken({
        factory: input.leaseTokenFactory,
        action,
        index,
      });
      const claimResult = await claim(input.db, {
        deliveryId: action.deliveryId,
        leaseToken,
        now: claimedAt,
        leaseMs: input.leaseMs,
      });
      claimedDelivery = claimResult.delivery as ClaimedChannexAriDelivery;
      assertClaimMatchesPreflight({
        claimed: claimedDelivery,
        preflight,
      });

      phase = "EXECUTE";
      const execution = await execute({
        db: input.db,
        delivery: claimedDelivery,
        apiKey: credentials.apiKey,
        baseUrl: input.baseUrl,
        timeoutMs: input.timeoutMs,
        jitterMs: input.jitterMs,
        completionReserveMs: input.completionReserveMs,
        transport: input.transport,
        clock: input.clock,
      });

      results.push({
        action,
        outcome: "EXECUTED",
        claimedAt,
        credentials: credentials.evidence,
        execution,
      });
    } catch (error) {
      results.push({
        action,
        outcome: "FAILED",
        failure: {
          phase,
          errorCode: publicErrorCode(error),
          claimed: Boolean(claimedDelivery),
          ...(claimedDelivery
            ? {
                attemptCount: claimedDelivery.attemptCount,
                leaseExpiresAt: claimedDelivery.leaseExpiresAt,
              }
            : {}),
        },
      });
    }
  }

  const recoveredCount = results.filter(
    (result) => result.outcome === "RECOVERED"
  ).length;
  const executedCount = results.filter(
    (result) => result.outcome === "EXECUTED"
  ).length;
  const failedCount = results.length - recoveredCount - executedCount;

  return {
    selectedCount: actions.length,
    recoveredCount,
    executedCount,
    failedCount,
    results,
  };
}
