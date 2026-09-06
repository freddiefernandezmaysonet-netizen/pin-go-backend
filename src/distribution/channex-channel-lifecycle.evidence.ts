import { createHash } from "node:crypto";

import type { ConnectionCenterProvider } from "./connection-center.read-model.js";

export const CHANNEX_CHANNEL_LIFECYCLE_EVENTS = [
  "new_channel",
  "updated_channel",
  "activate_channel",
  "deactivate_channel",
  "disconnected_channel",
  "disconnect_listing",
] as const;

export type ChannexChannelLifecycleEventType =
  (typeof CHANNEX_CHANNEL_LIFECYCLE_EVENTS)[number];

export type NormalizedChannexChannelLifecycleEvent = {
  eventType: ChannexChannelLifecycleEventType;
  provider: ConnectionCenterProvider | null;
  externalPropertyId: string;
  externalConnectionId: string | null;
  externalChannelCode: string | null;
  externalEventId: string | null;
  occurredAt: Date | null;
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
  const result = String(value ?? "").trim();
  if (!result || result.length > max) return null;
  return result;
}

function parseDate(value: unknown): Date | null {
  const raw = normalizedString(value, 120);
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function providerFromChannelCode(value: string | null): ConnectionCenterProvider | null {
  const code = String(value ?? "").trim().toUpperCase();
  if (code === "ABB" || code === "AIRBNB") return "AIRBNB";
  if (code === "BDC" || code === "BOOKING" || code === "BOOKING_COM") {
    return "BOOKING_COM";
  }
  return null;
}

function stablePayloadHash(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload ?? null)).digest("hex");
}

export function normalizeChannexChannelLifecycleEvent(
  payload: unknown
): NormalizedChannexChannelLifecycleEvent | null {
  const root = record(payload);
  if (Object.keys(root).length === 0) {
    throw new ChannexChannelEvidenceError("OTA_CHANNEL_WEBHOOK_PAYLOAD_INVALID");
  }

  const envelope = record(root.payload);
  const data = record(root.data ?? envelope.data);
  const attributes = record(data.attributes ?? root.attributes ?? envelope.attributes);

  const eventType = normalizedString(
    root.event ?? root.event_type ?? envelope.event ?? envelope.event_type ?? root.name,
    80
  )?.toLowerCase();

  if (!eventType || !(CHANNEX_CHANNEL_LIFECYCLE_EVENTS as readonly string[]).includes(eventType)) {
    return null;
  }

  const externalPropertyId = normalizedString(
    attributes.property_id ?? data.property_id ?? root.property_id ?? envelope.property_id,
    120
  );
  if (!externalPropertyId) {
    throw new ChannexChannelEvidenceError("OTA_CHANNEL_EXTERNAL_PROPERTY_ID_REQUIRED");
  }

  const externalConnectionId = normalizedString(
    data.id ?? attributes.channel_id ?? root.channel_id ?? envelope.channel_id,
    120
  );
  const externalChannelCode = normalizedString(
    attributes.channel ??
      attributes.channel_code ??
      attributes.provider_code ??
      root.channel ??
      root.channel_code ??
      envelope.channel,
    120
  );
  const externalEventId = normalizedString(
    root.event_id ?? root.webhook_id ?? envelope.event_id ?? envelope.webhook_id,
    160
  );
  const occurredAt = parseDate(
    root.occurred_at ?? root.inserted_at ?? root.created_at ?? envelope.occurred_at
  );

  return {
    eventType: eventType as ChannexChannelLifecycleEventType,
    provider: providerFromChannelCode(externalChannelCode),
    externalPropertyId,
    externalConnectionId,
    externalChannelCode,
    externalEventId,
    occurredAt,
    payloadHash: stablePayloadHash(payload),
  };
}

function decisionId(event: NormalizedChannexChannelLifecycleEvent): string {
  const eventIdentity =
    event.externalEventId ??
    [
      event.eventType,
      event.externalPropertyId,
      event.externalConnectionId ?? "none",
      event.externalChannelCode ?? "none",
      event.occurredAt?.toISOString() ?? "no-time",
      event.payloadHash,
    ].join(":");
  return `ota-channel-evidence:${createHash("sha256").update(eventIdentity).digest("hex")}`;
}

function evidencePatch(
  event: NormalizedChannexChannelLifecycleEvent,
  now: Date
): Record<string, unknown> {
  const identity: Record<string, unknown> = {
    lastReadinessCheckedAt: now,
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
        authorizationReadiness: "IN_PROGRESS",
        mappingReadiness: "NOT_STARTED",
        distributionReadiness: "NOT_STARTED",
        lastErrorCode: null,
      };
    case "updated_channel":
    case "activate_channel":
      return {
        ...identity,
        authorizationReadiness: "IN_PROGRESS",
        mappingReadiness: "IN_PROGRESS",
        distributionReadiness: "IN_PROGRESS",
        lastErrorCode: null,
      };
    case "deactivate_channel":
      return {
        ...identity,
        distributionReadiness: "BLOCKED",
        lastErrorCode: "OTA_CHANNEL_DEACTIVATED",
      };
    case "disconnect_listing":
      return {
        ...identity,
        mappingReadiness: "BLOCKED",
        distributionReadiness: "BLOCKED",
        lastErrorCode: "OTA_CHANNEL_LISTING_DISCONNECTED",
      };
    case "disconnected_channel":
      return {
        ...identity,
        status: "DISCONNECTED",
        authorizationReadiness: "REQUIRED",
        mappingReadiness: "BLOCKED",
        distributionReadiness: "BLOCKED",
        disconnectedAt: now,
        lastErrorCode: "OTA_CHANNEL_DISCONNECTED",
      };
  }
}

export type ChannexChannelEvidenceClient = {
  $transaction<T>(work: (tx: any) => Promise<T>): Promise<T>;
};

export async function applyChannexChannelLifecycleEvidence(args: {
  client: ChannexChannelEvidenceClient;
  payload: unknown;
  now?: Date;
}): Promise<OtaChannelEvidenceResult> {
  const normalized = normalizeChannexChannelLifecycleEvent(args.payload);
  if (!normalized) {
    return { ignored: true, ignoredReason: "UNSUPPORTED_EVENT" };
  }
  if (!normalized.provider) {
    return { ignored: true, ignoredReason: "UNSUPPORTED_CHANNEL" };
  }

  const now = args.now ?? new Date();
  const evidenceDecisionId = decisionId(normalized);

  return args.client.$transaction(async (tx) => {
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
        externalConnectionId: true,
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

    const existingAudit = await tx.apmsAuditEntry.findUnique({
      where: { decisionId: evidenceDecisionId },
      select: { id: true },
    });
    if (existingAudit) {
      return {
        ignored: false,
        deduped: true,
        connectionId: connection.id,
        eventType: normalized.eventType,
      };
    }

    if (
      connection.externalConnectionId &&
      normalized.externalConnectionId &&
      connection.externalConnectionId !== normalized.externalConnectionId
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
      },
      data: evidencePatch(normalized, now),
    });
    if (updated.count !== 1) {
      throw new ChannexChannelEvidenceError("OTA_CHANNEL_EVIDENCE_STATE_CONFLICT");
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
          sourceOccurredAt: normalized.occurredAt?.toISOString() ?? null,
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
  });
}
