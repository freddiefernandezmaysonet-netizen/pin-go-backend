import { createHash } from "node:crypto";

import type { ConnectionCenterProvider } from "./connection-center.read-model.js";

export const CHANNEX_CHANNEL_LIFECYCLE_EVENTS = [
  "new_channel",
  "updated_channel",
  "activate_channel",
  "deactivate_channel",
  "disconnect_channel",
  "disconnect_listing",
] as const;

export const CHANNEX_CHANNEL_LIFECYCLE_EVENT_MASK =
  CHANNEX_CHANNEL_LIFECYCLE_EVENTS.join(";");

export type ChannexChannelLifecycleEventType =
  (typeof CHANNEX_CHANNEL_LIFECYCLE_EVENTS)[number];

export const CHANNEX_CHANNEL_LIFECYCLE_EVENT_PRECEDENCE: Readonly<
  Record<ChannexChannelLifecycleEventType, number>
> = Object.freeze({
  new_channel: 10,
  updated_channel: 20,
  activate_channel: 30,
  deactivate_channel: 40,
  disconnect_listing: 50,
  disconnect_channel: 60,
});

const LIFECYCLE_SERIALIZATION_MAX_RETRIES = 2;
const LIFECYCLE_SERIALIZATION_RETRY_BASE_MS = 10;
const LIFECYCLE_MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
const CHANNEX_UTC_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?Z$/;
const CHANNEX_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type NormalizedChannexChannelLifecycleEvent = {
  eventType: ChannexChannelLifecycleEventType;
  provider: ConnectionCenterProvider | null;
  externalPropertyId: string;
  externalConnectionId: string | null;
  externalChannelCode: string | null;
  externalEventId: string | null;
  occurredAt: Date;
  occurredAtMicros: bigint;
  payloadHash: string;
};

export type OtaChannelEvidenceResult = {
  ignored: boolean;
  ignoredReason?: string;
  deduped?: boolean;
  connectionId?: string;
  eventType?: ChannexChannelLifecycleEventType;
};

export class ChannexChannelEvidenceError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ChannexChannelEvidenceError";
  }
}

function record(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, any>)
    : {};
}

function normalizedString(value: unknown, max = 255): string | null {
  const result = typeof value === "string" ? value.trim() : "";
  if (!result || result.length > max) return null;
  return result;
}

function requiredChannexUuid(
  value: unknown,
  requiredCode: string,
  invalidCode: string
): string {
  const result = normalizedString(value, 36);
  if (!result) {
    throw new ChannexChannelEvidenceError(requiredCode);
  }
  if (!CHANNEX_UUID.test(result)) {
    throw new ChannexChannelEvidenceError(invalidCode);
  }
  return result;
}

function parseOccurredAt(value: unknown): {
  occurredAt: Date;
  occurredAtMicros: bigint;
} {
  const raw = normalizedString(value, 120);
  if (!raw) {
    throw new ChannexChannelEvidenceError("OTA_CHANNEL_OCCURRED_AT_REQUIRED");
  }
  const match = CHANNEX_UTC_TIMESTAMP.exec(raw);
  if (!match) {
    throw new ChannexChannelEvidenceError("OTA_CHANNEL_OCCURRED_AT_INVALID");
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const fractionalSeconds = String(match[7] ?? "");
  const daysInMonth =
    month >= 1 && month <= 12
      ? new Date(Date.UTC(year, month, 0)).getUTCDate()
      : 0;
  if (
    year < 1970 ||
    day < 1 ||
    day > daysInMonth ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    throw new ChannexChannelEvidenceError("OTA_CHANNEL_OCCURRED_AT_INVALID");
  }
  const epochSecondMillis = Date.UTC(year, month - 1, day, hour, minute, second);
  const microsecondFraction = BigInt(fractionalSeconds.padEnd(6, "0") || "000000");
  const parsed = new Date(
    epochSecondMillis + Number(microsecondFraction / 1000n)
  );
  if (Number.isNaN(parsed.getTime()) || !Number.isSafeInteger(epochSecondMillis)) {
    throw new ChannexChannelEvidenceError("OTA_CHANNEL_OCCURRED_AT_INVALID");
  }
  return {
    occurredAt: parsed,
    occurredAtMicros: BigInt(epochSecondMillis) * 1000n + microsecondFraction,
  };
}

function providerFromChannelCode(value: string | null): ConnectionCenterProvider | null {
  const code = value?.trim() ?? "";
  if (code === "Airbnb") return "AIRBNB";
  if (code === "BookingCom") return "BOOKING_COM";
  return null;
}

function canonicalChannelCode(
  provider: ConnectionCenterProvider | null
): string | null {
  if (provider === "AIRBNB") return "ABB";
  if (provider === "BOOKING_COM") return "BDC";
  return null;
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => [
        key,
        canonicalJsonValue((value as Record<string, unknown>)[key]),
      ])
  );
}

function stablePayloadHash(payload: unknown): string {
  const canonicalPayload = JSON.stringify(canonicalJsonValue(payload ?? null));
  return createHash("sha256").update(canonicalPayload ?? "null").digest("hex");
}

export function normalizeChannexChannelLifecycleEvent(
  payload: unknown
): NormalizedChannexChannelLifecycleEvent | null {
  const root = record(payload);
  if (Object.keys(root).length === 0) {
    throw new ChannexChannelEvidenceError("OTA_CHANNEL_WEBHOOK_PAYLOAD_INVALID");
  }

  const envelope = record(root.payload);

  const eventType = normalizedString(root.event, 80)?.toLowerCase();

  if (!eventType || !(CHANNEX_CHANNEL_LIFECYCLE_EVENTS as readonly string[]).includes(eventType)) {
    return null;
  }

  const externalPropertyId = requiredChannexUuid(
    root.property_id,
    "OTA_CHANNEL_EXTERNAL_PROPERTY_ID_REQUIRED",
    "OTA_CHANNEL_EXTERNAL_PROPERTY_ID_INVALID"
  );

  const externalConnectionId = requiredChannexUuid(
    envelope.channel_id,
    "OTA_CHANNEL_EXTERNAL_CONNECTION_ID_REQUIRED",
    "OTA_CHANNEL_EXTERNAL_CONNECTION_ID_INVALID"
  );
  const providerValue = normalizedString(
    envelope.ota_name,
    120
  );
  const provider = providerFromChannelCode(providerValue);
  const externalChannelCode = canonicalChannelCode(provider);
  const externalEventId = null;
  const { occurredAt, occurredAtMicros } = parseOccurredAt(root.timestamp);

  return {
    eventType: eventType as ChannexChannelLifecycleEventType,
    provider,
    externalPropertyId,
    externalConnectionId,
    externalChannelCode,
    externalEventId,
    occurredAt,
    occurredAtMicros,
    payloadHash: stablePayloadHash({
      event: eventType,
      timestamp: normalizedString(root.timestamp, 120),
      property_id: externalPropertyId,
      payload: {
        channel_id: externalConnectionId,
        ota_name: providerValue,
      },
    }),
  };
}

function decisionId(
  connectionId: string,
  event: NormalizedChannexChannelLifecycleEvent
): string {
  const eventIdentity = [
    "CHANNEX",
    connectionId,
    event.eventType,
    event.externalPropertyId,
    event.externalConnectionId ?? "none",
    event.externalChannelCode ?? "none",
    event.occurredAtMicros.toString(),
    event.externalEventId
      ? `event:${event.externalEventId}`
      : `payload:${event.payloadHash}`,
  ].join("\u0000");
  return `ota-channel-evidence:${createHash("sha256").update(eventIdentity).digest("hex")}`;
}

function evidencePatch(
  event: NormalizedChannexChannelLifecycleEvent,
  currentStatus: string
): Record<string, unknown> {
  const degradeActive = currentStatus === "ACTIVE" ? { status: "DEGRADED" } : {};
  const rewindAuthorization = [
    "MAPPING_REQUIRED",
    "READINESS_CHECK",
    "ACTIVATION_PENDING",
  ].includes(currentStatus)
    ? { status: "AUTHORIZATION_REQUIRED" }
    : {};
  const rewindMapping = ["READINESS_CHECK", "ACTIVATION_PENDING"].includes(
    currentStatus
  )
    ? { status: "MAPPING_REQUIRED" }
    : {};
  const rewindDistribution = currentStatus === "ACTIVATION_PENDING"
    ? { status: "READINESS_CHECK" }
    : {};
  const restartAuthorization = [
    "NOT_CONNECTED",
    "FAILED",
    "DISCONNECTED",
  ].includes(currentStatus)
    ? { status: "AUTHORIZATION_REQUIRED" }
    : { ...rewindAuthorization, ...degradeActive };
  const identity: Record<string, unknown> = {
    paymentReadiness: "NOT_STARTED",
    taxReadiness: "NOT_STARTED",
    contentReadiness: "NOT_STARTED",
    // Every accepted lifecycle mutation opens a new evidence epoch. The
    // canonical reconciler may stamp this again only after the new epoch has
    // exact channel, mapping and full-sync evidence.
    activatedAt: null,
    lastFullSyncConfirmedAt: null,
    ...(event.externalConnectionId
      ? { externalConnectionId: event.externalConnectionId }
      : {}),
    ...(event.externalChannelCode
      ? { externalChannelCode: event.externalChannelCode }
      : {}),
  };

  switch (event.eventType) {
    case "new_channel":
      return {
        ...identity,
        ...restartAuthorization,
        authorizationReadiness: "IN_PROGRESS",
        mappingReadiness: "NOT_STARTED",
        distributionReadiness: "NOT_STARTED",
        activationRequestedAt: null,
        disconnectedAt: null,
        externalListingId: null,
        channelAuthorizationVerifiedAt: null,
        lastChannelActivatedAt: null,
        lastErrorCode: null,
        lastErrorSummary: null,
      };
    case "updated_channel":
      return {
        ...identity,
        ...rewindMapping,
        ...degradeActive,
        authorizationReadiness: "IN_PROGRESS",
        mappingReadiness: "IN_PROGRESS",
        distributionReadiness: "IN_PROGRESS",
        lastErrorCode: null,
        lastErrorSummary: null,
      };
    case "activate_channel":
      return {
        ...identity,
        ...rewindAuthorization,
        ...degradeActive,
        authorizationReadiness: "IN_PROGRESS",
        mappingReadiness: "IN_PROGRESS",
        distributionReadiness: "IN_PROGRESS",
        channelAuthorizationVerifiedAt: event.occurredAt,
        lastChannelActivatedAt: event.occurredAt,
        lastErrorCode: null,
        lastErrorSummary: null,
      };
    case "deactivate_channel":
      return {
        ...identity,
        ...rewindDistribution,
        ...degradeActive,
        distributionReadiness: "BLOCKED",
        lastChannelActivatedAt: null,
        lastErrorCode: "OTA_CHANNEL_DEACTIVATED",
        lastErrorSummary: "Channex reported the channel as deactivated",
      };
    case "disconnect_listing":
      return {
        ...identity,
        ...rewindMapping,
        ...degradeActive,
        mappingReadiness: "BLOCKED",
        distributionReadiness: "BLOCKED",
        externalListingId: null,
        lastChannelActivatedAt: null,
        lastErrorCode: "OTA_CHANNEL_LISTING_DISCONNECTED",
        lastErrorSummary: "Channex reported the channel listing as disconnected",
      };
    case "disconnect_channel":
      return {
        ...identity,
        status: "DISCONNECTED",
        authorizationReadiness: "REQUIRED",
        mappingReadiness: "BLOCKED",
        distributionReadiness: "BLOCKED",
        activationRequestedAt: null,
        externalListingId: null,
        disconnectedAt: event.occurredAt,
        channelAuthorizationVerifiedAt: null,
        lastChannelActivatedAt: null,
        lastErrorCode: "OTA_CHANNEL_DISCONNECTED",
        lastErrorSummary: "Channex reported the channel as disconnected",
      };
  }
}

export type ChannexChannelEvidenceClient = {
  $transaction<T>(
    work: (tx: any) => Promise<T>,
    options?: { isolationLevel?: "Serializable" }
  ): Promise<T>;
};

type LifecycleWatermark = {
  occurredAt: Date;
  occurredAtMicros: bigint;
  eventType: ChannexChannelLifecycleEventType;
  precedence: number;
};

class LifecycleEvidenceCasConflict extends Error {}

function persistedReadinessRevision(connection: Record<string, any>): number {
  const revision = connection.readinessRevision;
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new ChannexChannelEvidenceError(
      "OTA_CHANNEL_READINESS_REVISION_INVALID"
    );
  }
  return revision;
}

function persistedWatermark(connection: Record<string, any>): LifecycleWatermark | null {
  const occurredAtValue = connection.lastLifecycleOccurredAt ?? null;
  const occurredAtMicrosValue =
    connection.lastLifecycleOccurredAtMicros ?? null;
  const eventTypeValue = connection.lastLifecycleEventType ?? null;
  const precedenceValue = connection.lastLifecycleEventPrecedence ?? null;
  const authorizationVerifiedAtValue =
    connection.channelAuthorizationVerifiedAt ?? null;
  const lastChannelActivatedAtValue =
    connection.lastChannelActivatedAt ?? null;

  if (
    occurredAtValue === null &&
    occurredAtMicrosValue === null &&
    eventTypeValue === null &&
    precedenceValue === null
  ) {
    if (
      authorizationVerifiedAtValue !== null ||
      lastChannelActivatedAtValue !== null
    ) {
      throw new ChannexChannelEvidenceError(
        "OTA_CHANNEL_LIFECYCLE_WATERMARK_INVALID"
      );
    }
    return null;
  }
  if (
    occurredAtValue === null ||
    occurredAtMicrosValue === null ||
    eventTypeValue === null ||
    precedenceValue === null
  ) {
    throw new ChannexChannelEvidenceError(
      "OTA_CHANNEL_LIFECYCLE_WATERMARK_INVALID"
    );
  }

  const occurredAt = new Date(occurredAtValue);
  let occurredAtMicros: bigint;
  try {
    occurredAtMicros = BigInt(occurredAtMicrosValue);
  } catch {
    throw new ChannexChannelEvidenceError(
      "OTA_CHANNEL_LIFECYCLE_WATERMARK_INVALID"
    );
  }
  const eventType = String(eventTypeValue ?? "") as ChannexChannelLifecycleEventType;
  const precedence = Number(precedenceValue);
  if (
    Number.isNaN(occurredAt.getTime()) ||
    occurredAt.getTime() < 0 ||
    occurredAtMicros < 0n ||
    occurredAtMicros / 1000n !== BigInt(occurredAt.getTime()) ||
    !(CHANNEX_CHANNEL_LIFECYCLE_EVENTS as readonly string[]).includes(eventType) ||
    !Number.isInteger(precedence) ||
    CHANNEX_CHANNEL_LIFECYCLE_EVENT_PRECEDENCE[eventType] !== precedence
  ) {
    throw new ChannexChannelEvidenceError(
      "OTA_CHANNEL_LIFECYCLE_WATERMARK_INVALID"
    );
  }

  if (
    lastChannelActivatedAtValue !== null &&
    authorizationVerifiedAtValue === null
  ) {
    throw new ChannexChannelEvidenceError(
      "OTA_CHANNEL_LIFECYCLE_WATERMARK_INVALID"
    );
  }

  for (const auxiliaryInstant of [
    authorizationVerifiedAtValue,
    lastChannelActivatedAtValue,
  ]) {
    if (auxiliaryInstant === null) continue;
    const parsed = new Date(auxiliaryInstant);
    if (
      Number.isNaN(parsed.getTime()) ||
      parsed.getTime() > occurredAt.getTime()
    ) {
      throw new ChannexChannelEvidenceError(
        "OTA_CHANNEL_LIFECYCLE_WATERMARK_INVALID"
      );
    }
  }

  return { occurredAt, occurredAtMicros, eventType, precedence };
}

function compareLifecycleOrder(
  event: NormalizedChannexChannelLifecycleEvent,
  watermark: LifecycleWatermark | null
): number {
  if (!watermark) return 1;
  if (event.occurredAtMicros !== watermark.occurredAtMicros) {
    return event.occurredAtMicros > watermark.occurredAtMicros ? 1 : -1;
  }
  return (
    CHANNEX_CHANNEL_LIFECYCLE_EVENT_PRECEDENCE[event.eventType] -
    watermark.precedence
  );
}

function isRetryablePersistenceConflict(error: unknown): boolean {
  if (error instanceof LifecycleEvidenceCasConflict) return true;
  if (!error || typeof error !== "object") return false;
  const code =
    "code" in error && typeof error.code === "string" ? error.code : null;
  if (code === "P2034") return true;
  if (code === "P2002") {
    const target = "meta" in error
      ? JSON.stringify((error as { meta?: unknown }).meta ?? null)
      : "";
    return target.includes("decisionId");
  }
  const message =
    "message" in error && typeof error.message === "string" ? error.message : "";
  return /transaction failed due to a write conflict or a deadlock/i.test(message);
}

async function waitForPersistenceRetry(retryNumber: number) {
  await new Promise<void>((resolve) =>
    setTimeout(resolve, LIFECYCLE_SERIALIZATION_RETRY_BASE_MS * retryNumber)
  );
}

export async function applyChannexChannelLifecycleEvidence(args: {
  client: ChannexChannelEvidenceClient;
  payload: unknown;
  now?: Date;
}): Promise<OtaChannelEvidenceResult> {
  const now = args.now ?? new Date();
  if (Number.isNaN(now.getTime())) {
    throw new ChannexChannelEvidenceError("OTA_CHANNEL_INGEST_TIME_INVALID");
  }
  const normalized = normalizeChannexChannelLifecycleEvent(args.payload);
  if (!normalized) {
    return { ignored: true, ignoredReason: "UNSUPPORTED_EVENT" };
  }
  if (!normalized.provider) {
    return { ignored: true, ignoredReason: "UNSUPPORTED_CHANNEL" };
  }
  if (
    normalized.occurredAt.getTime() >
    now.getTime() + LIFECYCLE_MAX_FUTURE_SKEW_MS
  ) {
    throw new ChannexChannelEvidenceError(
      "OTA_CHANNEL_OCCURRED_AT_FUTURE_SKEW"
    );
  }

  const runTransaction = () => args.client.$transaction(async (tx) => {
    const distributionProperty = await tx.distributionProperty.findFirst({
      where: {
        platform: "CHANNEX",
        externalPropertyId: normalized.externalPropertyId,
      },
      select: {
        id: true,
        organizationId: true,
        propertyId: true,
      },
    });
    if (!distributionProperty) {
      throw new ChannexChannelEvidenceError("OTA_CHANNEL_PROPERTY_MAPPING_NOT_FOUND");
    }

    const connection = await tx.otaChannelConnection.findFirst({
      where: {
        distributionPropertyId: distributionProperty.id,
        provider: normalized.provider,
      },
      select: {
        id: true,
        organizationId: true,
        propertyId: true,
        distributionPropertyId: true,
        provider: true,
        status: true,
        externalConnectionId: true,
        externalChannelCode: true,
        externalListingId: true,
        updatedAt: true,
        lastLifecycleOccurredAt: true,
        lastLifecycleOccurredAtMicros: true,
        lastLifecycleEventType: true,
        lastLifecycleEventPrecedence: true,
        channelAuthorizationVerifiedAt: true,
        lastChannelActivatedAt: true,
        readinessRevision: true,
      },
    });
    if (!connection) {
      throw new ChannexChannelEvidenceError("OTA_CHANNEL_CONNECTION_NOT_PREPARED");
    }
    if (
      connection.organizationId !== distributionProperty.organizationId ||
      connection.propertyId !== distributionProperty.propertyId ||
      connection.distributionPropertyId !== distributionProperty.id ||
      connection.provider !== normalized.provider
    ) {
      throw new ChannexChannelEvidenceError("OTA_DISTRIBUTION_TENANT_MISMATCH");
    }

    const evidenceDecisionId = decisionId(connection.id, normalized);
    const existingAudit = await tx.apmsAuditEntry.findUnique({
      where: { decisionId: evidenceDecisionId },
      select: { id: true },
    });
    if (existingAudit) {
      return {
        ignored: true,
        ignoredReason: "DUPLICATE_LIFECYCLE_EVENT",
        deduped: true,
        connectionId: connection.id,
        eventType: normalized.eventType,
      };
    }

    const watermark = persistedWatermark(connection);
    const readinessRevision = persistedReadinessRevision(connection);
    if (compareLifecycleOrder(normalized, watermark) <= 0) {
      await tx.apmsAuditEntry.create({
        data: {
          organizationId: distributionProperty.organizationId,
          propertyId: distributionProperty.propertyId,
          entityType: "DISTRIBUTION",
          entityId: connection.id,
          engine: "OTA_DISTRIBUTION",
          eventType: "DECISION_SKIPPED",
          status: "SUCCESS",
          severity: "INFO",
          decisionId: evidenceDecisionId,
          summary: "Stale Channex OTA channel lifecycle evidence ignored",
          reason: normalized.eventType,
          metadata: {
            provider: normalized.provider,
            externalPropertyId: normalized.externalPropertyId,
            externalConnectionId: normalized.externalConnectionId,
            externalChannelCode: normalized.externalChannelCode,
            sourceOccurredAt: normalized.occurredAt.toISOString(),
            sourceOccurredAtMicros: normalized.occurredAtMicros.toString(),
            sourceEventPrecedence:
              CHANNEX_CHANNEL_LIFECYCLE_EVENT_PRECEDENCE[normalized.eventType],
            persistedOccurredAt: watermark?.occurredAt.toISOString() ?? null,
            persistedOccurredAtMicros:
              watermark?.occurredAtMicros.toString() ?? null,
            persistedEventType: watermark?.eventType ?? null,
            persistedEventPrecedence: watermark?.precedence ?? null,
            orderingOutcome: "STALE_OR_SUPERSEDED",
            canonicalReadinessPromotion: false,
          },
          startedAt: now,
          completedAt: now,
          durationMs: 0,
        },
      });

      return {
        ignored: true,
        ignoredReason: "STALE_LIFECYCLE_EVENT",
        deduped: false,
        connectionId: connection.id,
        eventType: normalized.eventType,
      };
    }

    const replacesDisconnectedChannel =
      connection.status === "DISCONNECTED" &&
      normalized.eventType === "new_channel";
    if (
      connection.externalConnectionId &&
      normalized.externalConnectionId &&
      connection.externalConnectionId !== normalized.externalConnectionId &&
      !replacesDisconnectedChannel
    ) {
      throw new ChannexChannelEvidenceError("OTA_CHANNEL_EXTERNAL_CONNECTION_CONFLICT");
    }

    const updated = await tx.otaChannelConnection.updateMany({
      where: {
        id: connection.id,
        organizationId: distributionProperty.organizationId,
        propertyId: distributionProperty.propertyId,
        distributionPropertyId: distributionProperty.id,
        provider: normalized.provider,
        status: connection.status,
        externalConnectionId: connection.externalConnectionId,
        externalChannelCode: connection.externalChannelCode,
        externalListingId: connection.externalListingId,
        readinessRevision,
        updatedAt: connection.updatedAt,
        lastLifecycleOccurredAt: connection.lastLifecycleOccurredAt ?? null,
        lastLifecycleOccurredAtMicros:
          connection.lastLifecycleOccurredAtMicros ?? null,
        lastLifecycleEventType: connection.lastLifecycleEventType ?? null,
        lastLifecycleEventPrecedence:
          connection.lastLifecycleEventPrecedence ?? null,
        channelAuthorizationVerifiedAt:
          connection.channelAuthorizationVerifiedAt ?? null,
        lastChannelActivatedAt: connection.lastChannelActivatedAt ?? null,
      },
      data: {
        ...evidencePatch(normalized, connection.status),
        lastLifecycleOccurredAt: normalized.occurredAt,
        lastLifecycleOccurredAtMicros: normalized.occurredAtMicros,
        lastLifecycleEventType: normalized.eventType,
        lastLifecycleEventPrecedence:
          CHANNEX_CHANNEL_LIFECYCLE_EVENT_PRECEDENCE[normalized.eventType],
        readinessRevision: { increment: 1 },
      },
    });
    if (updated.count !== 1) {
      throw new LifecycleEvidenceCasConflict();
    }

    await tx.apmsAuditEntry.create({
      data: {
        organizationId: distributionProperty.organizationId,
        propertyId: distributionProperty.propertyId,
        entityType: "DISTRIBUTION",
        entityId: connection.id,
        engine: "OTA_DISTRIBUTION",
        eventType: "DECISION_APPLIED",
        status: "SUCCESS",
        severity: "INFO",
        decisionId: evidenceDecisionId,
        summary: "Channex OTA channel lifecycle evidence ingested",
        reason: normalized.eventType,
        metadata: {
          provider: normalized.provider,
          externalPropertyId: normalized.externalPropertyId,
          externalConnectionId: normalized.externalConnectionId,
          externalChannelCode: normalized.externalChannelCode,
          sourceOccurredAt: normalized.occurredAt.toISOString(),
          sourceOccurredAtMicros: normalized.occurredAtMicros.toString(),
          sourceEventPrecedence:
            CHANNEX_CHANNEL_LIFECYCLE_EVENT_PRECEDENCE[normalized.eventType],
          previousLifecycleOccurredAt: watermark?.occurredAt.toISOString() ?? null,
          previousLifecycleOccurredAtMicros:
            watermark?.occurredAtMicros.toString() ?? null,
          previousLifecycleEventType: watermark?.eventType ?? null,
          previousLifecycleEventPrecedence: watermark?.precedence ?? null,
          previousReadinessRevision: readinessRevision,
          canonicalReadinessRevision: readinessRevision + 1,
          orderingOutcome: "APPLIED",
          canonicalReadinessPromotion: false,
        },
        startedAt: now,
        completedAt: now,
        durationMs: 0,
      },
    });

    return {
      ignored: false,
      deduped: false,
      connectionId: connection.id,
      eventType: normalized.eventType,
    };
  }, { isolationLevel: "Serializable" });

  for (
    let retryNumber = 0;
    retryNumber <= LIFECYCLE_SERIALIZATION_MAX_RETRIES;
    retryNumber += 1
  ) {
    try {
      return await runTransaction();
    } catch (error) {
      if (!isRetryablePersistenceConflict(error)) {
        if (
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "P2002"
        ) {
          throw new ChannexChannelEvidenceError(
            "OTA_CHANNEL_EXTERNAL_CONNECTION_CONFLICT"
          );
        }
        throw error;
      }
      if (retryNumber === LIFECYCLE_SERIALIZATION_MAX_RETRIES) {
        if (error instanceof LifecycleEvidenceCasConflict || (error as any)?.code === "P2034") {
          throw new ChannexChannelEvidenceError(
            "OTA_CHANNEL_EVIDENCE_STATE_CONFLICT"
          );
        }
        throw error;
      }
      await waitForPersistenceRetry(retryNumber + 1);
    }
  }

  throw new ChannexChannelEvidenceError("OTA_CHANNEL_EVIDENCE_STATE_CONFLICT");
}
