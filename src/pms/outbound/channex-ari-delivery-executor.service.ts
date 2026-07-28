import crypto from "node:crypto";
import type { Prisma } from "@prisma/client";

import {
  completeChannexAriDeliveryAttempt,
  type ChannexAriAttemptCompletionDb,
} from "./channex-ari-attempt-completion.service";
import {
  CHANNEX_ARI_HTTP_DEFAULT_TIMEOUT_MS,
  CHANNEX_ARI_HTTP_MAX_TIMEOUT_MS,
  sendChannexAriHttpRequest,
  type ChannexAriHttpTransport,
  type SendChannexAriHttpRequestInput,
  type SendChannexAriHttpRequestResult,
} from "./channex-ari-http.client";
import {
  CHANNEX_ARI_MAX_ATTEMPTS,
  CHANNEX_ARI_MAX_REQUEST_BYTES,
  type ChannexAriMessageKind,
} from "./channex-ari-lifecycle.policy";

export const CHANNEX_ARI_EXECUTOR_MIN_TIMEOUT_MS = 1_000;
export const CHANNEX_ARI_EXECUTOR_COMPLETION_RESERVE_MS = 5_000;

export type ClaimedChannexAriDelivery = {
  id: string;
  organizationId: string;
  propertyId: string;
  connectionId: string;
  listingId: string;
  messageKind: ChannexAriMessageKind;
  status: "PROCESSING";
  payload: Prisma.JsonValue;
  payloadHash: string;
  payloadValueCount: number;
  payloadBytes: number;
  attemptCount: number;
  leaseToken: string;
  leaseExpiresAt: Date;
};

export type ExecuteClaimedChannexAriDeliveryInput = {
  db: ChannexAriAttemptCompletionDb;
  delivery: ClaimedChannexAriDelivery;
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  jitterMs?: number;
  completionReserveMs?: number;
  transport?: ChannexAriHttpTransport;
  clock?: () => Date;
  send?: (
    input: SendChannexAriHttpRequestInput
  ) => Promise<SendChannexAriHttpRequestResult>;
  complete?: typeof completeChannexAriDeliveryAttempt;
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

function readClock(clock: (() => Date) | undefined, errorCode: string): Date {
  return assertValidDate(clock ? clock() : new Date(), errorCode);
}

function assertMessageKind(value: ChannexAriMessageKind): ChannexAriMessageKind {
  if (value !== "AVAILABILITY" && value !== "RATES_RESTRICTIONS") {
    throw new Error("CHANNEX_ARI_EXECUTOR_MESSAGE_KIND_INVALID");
  }

  return value;
}

function normalizeTimeoutMs(value?: number): number {
  const timeoutMs =
    value === undefined ? CHANNEX_ARI_HTTP_DEFAULT_TIMEOUT_MS : Number(value);

  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < CHANNEX_ARI_EXECUTOR_MIN_TIMEOUT_MS ||
    timeoutMs > CHANNEX_ARI_HTTP_MAX_TIMEOUT_MS
  ) {
    throw new Error("CHANNEX_ARI_EXECUTOR_TIMEOUT_INVALID");
  }

  return timeoutMs;
}

function normalizeCompletionReserveMs(value?: number): number {
  const reserveMs =
    value === undefined
      ? CHANNEX_ARI_EXECUTOR_COMPLETION_RESERVE_MS
      : Number(value);

  if (
    !Number.isSafeInteger(reserveMs) ||
    reserveMs < 0 ||
    reserveMs > 60_000
  ) {
    throw new Error("CHANNEX_ARI_EXECUTOR_COMPLETION_RESERVE_INVALID");
  }

  return reserveMs;
}

function assertPositiveInteger(
  value: number,
  errorCode: string,
  maximum?: number
): number {
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    (maximum !== undefined && value > maximum)
  ) {
    throw new Error(errorCode);
  }

  return value;
}

function assertPayloadIntegrity(input: {
  payload: Prisma.JsonValue;
  payloadHash: string;
  payloadValueCount: number;
  payloadBytes: number;
}): { payload: Prisma.JsonValue; payloadBytes: number; payloadValueCount: number } {
  if (!input.payload || typeof input.payload !== "object" || Array.isArray(input.payload)) {
    throw new Error("CHANNEX_ARI_EXECUTOR_PAYLOAD_INVALID");
  }

  const values = (input.payload as { values?: unknown }).values;

  if (!Array.isArray(values) || values.length === 0) {
    throw new Error("CHANNEX_ARI_EXECUTOR_PAYLOAD_VALUES_REQUIRED");
  }

  const payloadValueCount = assertPositiveInteger(
    input.payloadValueCount,
    "CHANNEX_ARI_EXECUTOR_VALUE_COUNT_INVALID"
  );

  if (values.length !== payloadValueCount) {
    throw new Error("CHANNEX_ARI_EXECUTOR_VALUE_COUNT_MISMATCH");
  }

  const serialized = JSON.stringify(input.payload);
  const payloadBytes = Buffer.byteLength(serialized, "utf8");

  if (
    !Number.isSafeInteger(input.payloadBytes) ||
    input.payloadBytes < 1 ||
    input.payloadBytes > CHANNEX_ARI_MAX_REQUEST_BYTES
  ) {
    throw new Error("CHANNEX_ARI_EXECUTOR_PAYLOAD_BYTES_INVALID");
  }

  if (payloadBytes !== input.payloadBytes) {
    throw new Error("CHANNEX_ARI_EXECUTOR_PAYLOAD_BYTES_MISMATCH");
  }

  const payloadHash = requireText(
    input.payloadHash,
    "CHANNEX_ARI_EXECUTOR_PAYLOAD_HASH_REQUIRED"
  ).toLowerCase();

  if (!/^[a-f0-9]{64}$/.test(payloadHash)) {
    throw new Error("CHANNEX_ARI_EXECUTOR_PAYLOAD_HASH_INVALID");
  }

  const actualHash = crypto
    .createHash("sha256")
    .update(serialized)
    .digest("hex");

  if (actualHash !== payloadHash) {
    throw new Error("CHANNEX_ARI_EXECUTOR_PAYLOAD_HASH_MISMATCH");
  }

  return {
    payload: input.payload,
    payloadBytes,
    payloadValueCount,
  };
}

function normalizeClaimedDelivery(
  delivery: ClaimedChannexAriDelivery
): ClaimedChannexAriDelivery {
  if (delivery.status !== "PROCESSING") {
    throw new Error("CHANNEX_ARI_EXECUTOR_PROCESSING_REQUIRED");
  }

  const normalized = {
    ...delivery,
    id: requireText(delivery.id, "CHANNEX_ARI_EXECUTOR_DELIVERY_ID_REQUIRED"),
    organizationId: requireText(
      delivery.organizationId,
      "CHANNEX_ARI_EXECUTOR_ORGANIZATION_ID_REQUIRED"
    ),
    propertyId: requireText(
      delivery.propertyId,
      "CHANNEX_ARI_EXECUTOR_PROPERTY_ID_REQUIRED"
    ),
    connectionId: requireText(
      delivery.connectionId,
      "CHANNEX_ARI_EXECUTOR_CONNECTION_ID_REQUIRED"
    ),
    listingId: requireText(
      delivery.listingId,
      "CHANNEX_ARI_EXECUTOR_LISTING_ID_REQUIRED"
    ),
    messageKind: assertMessageKind(delivery.messageKind),
    attemptCount: assertPositiveInteger(
      delivery.attemptCount,
      "CHANNEX_ARI_EXECUTOR_ATTEMPT_COUNT_INVALID",
      CHANNEX_ARI_MAX_ATTEMPTS
    ),
    leaseToken: requireText(
      delivery.leaseToken,
      "CHANNEX_ARI_EXECUTOR_LEASE_TOKEN_REQUIRED"
    ),
    leaseExpiresAt: assertValidDate(
      delivery.leaseExpiresAt,
      "CHANNEX_ARI_EXECUTOR_LEASE_EXPIRES_AT_INVALID"
    ),
  };

  assertPayloadIntegrity(normalized);
  return normalized;
}

export async function executeClaimedChannexAriDelivery(
  input: ExecuteClaimedChannexAriDeliveryInput
) {
  const delivery = normalizeClaimedDelivery(input.delivery);
  const apiKey = requireText(
    input.apiKey,
    "CHANNEX_ARI_EXECUTOR_API_KEY_REQUIRED"
  );
  const timeoutMs = normalizeTimeoutMs(input.timeoutMs);
  const completionReserveMs = normalizeCompletionReserveMs(
    input.completionReserveMs
  );
  const requestStartedAt = readClock(
    input.clock,
    "CHANNEX_ARI_EXECUTOR_REQUEST_STARTED_AT_INVALID"
  );
  const leaseRemainingMs =
    delivery.leaseExpiresAt.getTime() - requestStartedAt.getTime();
  const requiredLeaseRemainingMs = timeoutMs + completionReserveMs;

  if (leaseRemainingMs <= 0) {
    throw new Error("CHANNEX_ARI_EXECUTOR_LEASE_EXPIRED_BEFORE_HTTP");
  }

  if (leaseRemainingMs < requiredLeaseRemainingMs) {
    throw new Error("CHANNEX_ARI_EXECUTOR_LEASE_BUDGET_INSUFFICIENT");
  }

  const send = input.send ?? sendChannexAriHttpRequest;
  const complete = input.complete ?? completeChannexAriDeliveryAttempt;
  const httpResult = await send({
    messageKind: delivery.messageKind,
    payload: delivery.payload,
    apiKey,
    baseUrl: input.baseUrl,
    timeoutMs,
    receivedAt: requestStartedAt,
    transport: input.transport,
  });
  const completedAt = readClock(
    input.clock,
    "CHANNEX_ARI_EXECUTOR_COMPLETED_AT_INVALID"
  );

  if (completedAt.getTime() < requestStartedAt.getTime()) {
    throw new Error("CHANNEX_ARI_EXECUTOR_CLOCK_MOVED_BACKWARD");
  }

  if (completedAt.getTime() >= delivery.leaseExpiresAt.getTime()) {
    throw new Error("CHANNEX_ARI_EXECUTOR_LEASE_EXPIRED_AFTER_HTTP");
  }

  if (httpResult.payloadBytes !== delivery.payloadBytes) {
    throw new Error("CHANNEX_ARI_EXECUTOR_HTTP_PAYLOAD_BYTES_MISMATCH");
  }

  const completion = await complete(input.db, {
    deliveryId: delivery.id,
    leaseToken: delivery.leaseToken,
    evidence: httpResult.evidence,
    completedAt,
    jitterMs: input.jitterMs,
  });

  return {
    delivery: {
      id: delivery.id,
      organizationId: delivery.organizationId,
      propertyId: delivery.propertyId,
      connectionId: delivery.connectionId,
      listingId: delivery.listingId,
      messageKind: delivery.messageKind,
      attemptCount: delivery.attemptCount,
      payloadHash: delivery.payloadHash,
      payloadValueCount: delivery.payloadValueCount,
      payloadBytes: delivery.payloadBytes,
      leaseExpiresAt: delivery.leaseExpiresAt,
    },
    request: {
      endpoint: httpResult.endpoint,
      url: httpResult.url,
      startedAt: requestStartedAt,
      completedAt,
      durationMs: completedAt.getTime() - requestStartedAt.getTime(),
      timeoutMs,
      completionReserveMs,
      leaseRemainingAtStartMs: leaseRemainingMs,
    },
    evidence: httpResult.evidence,
    completion,
  };
}
