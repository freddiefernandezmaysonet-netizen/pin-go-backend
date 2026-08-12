import { PmsProvider } from "@prisma/client";
import { prisma } from "../lib/prisma";

const MAX_RECOVERY_ATTEMPTS = Number(
  process.env.PMS_WEBHOOK_RECOVERY_MAX_ATTEMPTS ?? 8
);

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string | null {
  if (value == null) return null;
  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : null;
}

function toPublicErrorCode(value: unknown) {
  const message = asString(value);
  if (!message) return null;

  const code = message.split(":")[0] ?? message;
  return code.replace(/^CHANNEX_/, "PIN_GO_CONNECT_");
}

function isHostActionError(code: string | null) {
  return [
    "PIN_GO_CONNECT_CANCELLATION_NOT_APPLIED",
    "PIN_GO_CONNECT_LISTING_MAPPING_NOT_FOUND",
    "PIN_GO_CONNECT_LISTING_NEEDS_PROPERTY_MAPPING",
    "PIN_GO_CONNECT_PROPERTY_MAPPING_MISMATCH",
    "PIN_GO_CONNECT_PROPERTY_MAPPING_NOT_FOUND",
    "PIN_GO_CONNECT_PROPERTY_MAPPING_AMBIGUOUS",
  ].includes(code ?? "");
}

export function getNextAutomaticAction(args: {
  persistenceStatus: string;
  acknowledgementStatus: string;
  eventStatus: string | null;
  attempts: number;
  errorCode: string | null;
}) {
  if (
    (args.persistenceStatus === "PERSISTED" ||
      args.persistenceStatus === "SUPERSEDED") &&
    args.acknowledgementStatus === "SENT"
  ) {
    return "NONE";
  }

  if (isHostActionError(args.errorCode)) {
    return "WAITING_FOR_HOST_REVIEW";
  }

  if (args.attempts >= MAX_RECOVERY_ATTEMPTS || args.eventStatus === "DEAD") {
    return "RECOVERY_EXHAUSTED";
  }

  if (args.acknowledgementStatus === "FAILED") {
    return "RETRY_ACKNOWLEDGEMENT";
  }

  if (
    args.eventStatus === "PENDING" ||
    args.eventStatus === "FAILED" ||
    args.eventStatus === "PROCESSING"
  ) {
    return "RETRY_BOOKING_REVISION";
  }

  if (
    (args.persistenceStatus === "PERSISTED" ||
      args.persistenceStatus === "SUPERSEDED") &&
    args.acknowledgementStatus === "PENDING"
  ) {
    return "RETRY_ACKNOWLEDGEMENT";
  }

  return "NONE";
}

export async function getDistributionLifecycleSnapshot(args: {
  organizationId: string;
  propertyId: string;
}) {
  const property = await prisma.property.findFirst({
    where: {
      id: args.propertyId,
      organizationId: args.organizationId,
      status: "ACTIVE",
    },
    select: {
      id: true,
      name: true,
    },
  });

  if (!property) {
    throw new Error("PROPERTY_NOT_FOUND");
  }

  const listing = await prisma.pmsListing.findFirst({
    where: {
      propertyId: property.id,
      connection: {
        is: {
          provider: PmsProvider.CHANNEX,
        },
      },
    },
    select: {
      metadata: true,
      connection: {
        select: {
          id: true,
          status: true,
        },
      },
    },
  });

  if (!listing) {
    return {
      provider: "PIN_GO_CONNECT",
      connected: false,
      connectionStatus: "NOT_CONFIGURED",
      propertyId: property.id,
      propertyName: property.name,
      generatedAt: new Date().toISOString(),
      summary: {
        persistedRevisions: 0,
        acknowledgedRevisions: 0,
        pendingRevisions: 0,
        recoverableErrors: 0,
        hostActionRequired: 0,
        recoveryExhausted: 0,
      },
      revisions: [],
      unresolvedEvents: [],
    };
  }

  const listingMetadata = asRecord(listing.metadata);
  const channexPropertyId = asString(listingMetadata.channexPropertyId);

  const propertyPayloadFilters: any[] = channexPropertyId
    ? [
        { payloadRaw: { path: ["property_id"], equals: channexPropertyId } },
        { payloadRaw: { path: ["propertyId"], equals: channexPropertyId } },
        {
          payloadRaw: {
            path: ["payload", "property_id"],
            equals: channexPropertyId,
          },
        },
        {
          payloadRaw: {
            path: ["payload", "attributes", "property_id"],
            equals: channexPropertyId,
          },
        },
        {
          payloadRaw: {
            path: ["data", "property_id"],
            equals: channexPropertyId,
          },
        },
        {
          payloadRaw: {
            path: ["data", "attributes", "property_id"],
            equals: channexPropertyId,
          },
        },
      ]
    : [];

  const [auditRows, eventRows] = await Promise.all([
    prisma.apmsAuditEntry.findMany({
      where: {
        propertyId: property.id,
        engine: "Distribution",
        decisionId: {
          startsWith: "distribution-engine:channex-revision:",
        },
      },
      orderBy: [
        { completedAt: "desc" },
        { createdAt: "desc" },
      ],
      take: 200,
      select: {
        decisionId: true,
        status: true,
        reason: true,
        metadata: true,
        completedAt: true,
        createdAt: true,
      },
    }),
    propertyPayloadFilters.length > 0
      ? prisma.webhookEventIngest.findMany({
          where: {
            connectionId: listing.connection.id,
            provider: PmsProvider.CHANNEX,
            OR: propertyPayloadFilters,
          },
          orderBy: { receivedAt: "desc" },
          take: 100,
          select: {
            id: true,
            eventType: true,
            externalEventId: true,
            status: true,
            attempts: true,
            lastError: true,
            receivedAt: true,
            processedAt: true,
            updatedAt: true,
          },
        })
      : Promise.resolve([]),
  ]);

  type RevisionState = {
    revisionId: string;
    bookingReference: string | null;
    otaReservationCode: string | null;
    webhookEventId: string | null;
    insertedAt: string | null;
    persistenceStatus: "PENDING" | "PERSISTED" | "SUPERSEDED" | "FAILED";
    acknowledgementStatus: "PENDING" | "SENT" | "FAILED";
    persistenceReason: string | null;
    acknowledgementReason: string | null;
    lastUpdatedAt: string | null;
  };

  const revisionsById = new Map<string, RevisionState>();

  for (const row of auditRows) {
    const metadata = asRecord(row.metadata);
    const revisionId = asString(metadata.revisionId);
    if (!revisionId) continue;

    const current = revisionsById.get(revisionId) ?? {
      revisionId,
      bookingReference:
        asString(metadata.otaReservationCode) ??
        asString(metadata.bookingUniqueId) ??
        asString(metadata.bookingId),
      otaReservationCode: asString(metadata.otaReservationCode),
      webhookEventId: asString(metadata.webhookEventId),
      insertedAt: asString(metadata.insertedAt),
      persistenceStatus: "PENDING" as const,
      acknowledgementStatus: "PENDING" as const,
      persistenceReason: null,
      acknowledgementReason: null,
      lastUpdatedAt: null,
    };

    const completedAt = (row.completedAt ?? row.createdAt).toISOString();
    if (!current.lastUpdatedAt || completedAt > current.lastUpdatedAt) {
      current.lastUpdatedAt = completedAt;
    }

    if (row.decisionId.endsWith(":persisted")) {
      current.persistenceReason = row.reason ?? null;

      if (row.status === "SUCCESS") {
        current.persistenceStatus = "PERSISTED";
      } else if (
        row.status === "SKIPPED" &&
        row.reason === "CHANNEX_REVISION_SUPERSEDED_OR_ALREADY_PERSISTED"
      ) {
        current.persistenceStatus = "SUPERSEDED";
      } else if (row.status === "FAILED") {
        current.persistenceStatus = "FAILED";
      }
    }

    if (row.decisionId.endsWith(":ack")) {
      current.acknowledgementReason = row.reason ?? null;

      if (row.status === "SUCCESS") {
        current.acknowledgementStatus = "SENT";
      } else if (row.status === "FAILED") {
        current.acknowledgementStatus = "FAILED";
      }
    }

    revisionsById.set(revisionId, current);
  }

  const eventById = new Map(eventRows.map((event) => [event.id, event]));

  const revisions = Array.from(revisionsById.values())
    .map((revision) => {
      const terminalHealthy =
        (revision.persistenceStatus === "PERSISTED" ||
          revision.persistenceStatus === "SUPERSEDED") &&
        revision.acknowledgementStatus === "SENT";
      const event =
        !terminalHealthy && revision.webhookEventId
          ? eventById.get(revision.webhookEventId) ?? null
          : null;
      const errorCode = toPublicErrorCode(event?.lastError);
      const attempts = event?.attempts ?? 0;
      const eventStatus = event?.status ?? null;
      const nextAutomaticAction = getNextAutomaticAction({
        persistenceStatus: revision.persistenceStatus,
        acknowledgementStatus: revision.acknowledgementStatus,
        eventStatus,
        attempts,
        errorCode,
      });
      const hostActionRequired = isHostActionError(errorCode);
      const recoverable =
        !hostActionRequired &&
        nextAutomaticAction !== "NONE" &&
        nextAutomaticAction !== "RECOVERY_EXHAUSTED";

      const { webhookEventId: _webhookEventId, ...publicRevision } = revision;

      return {
        ...publicRevision,
        eventStatus,
        attempts,
        errorCode,
        recoverable,
        hostActionRequired,
        nextAutomaticAction,
      };
    })
    .sort((left, right) =>
      String(right.insertedAt ?? right.lastUpdatedAt ?? "").localeCompare(
        String(left.insertedAt ?? left.lastUpdatedAt ?? "")
      )
    );

  const referencedEventIds = new Set(
    Array.from(revisionsById.values())
      .map((revision) => revision.webhookEventId)
      .filter((eventId): eventId is string => Boolean(eventId))
  );

  const unresolvedEvents = eventRows
    .filter(
      (event) =>
        !referencedEventIds.has(event.id) &&
        event.status !== "PROCESSED"
    )
    .map((event) => {
      const errorCode = toPublicErrorCode(event.lastError);
      const hostActionRequired = isHostActionError(errorCode);
      const nextAutomaticAction = getNextAutomaticAction({
        persistenceStatus: "PENDING",
        acknowledgementStatus: "PENDING",
        eventStatus: event.status,
        attempts: event.attempts,
        errorCode,
      });

      return {
        eventType: event.eventType,
        revisionId: event.externalEventId,
        eventStatus: event.status,
        attempts: event.attempts,
        errorCode,
        recoverable:
          !hostActionRequired &&
          nextAutomaticAction !== "NONE" &&
          nextAutomaticAction !== "RECOVERY_EXHAUSTED",
        hostActionRequired,
        nextAutomaticAction,
        receivedAt: event.receivedAt.toISOString(),
        processedAt: event.processedAt?.toISOString() ?? null,
        updatedAt: event.updatedAt.toISOString(),
      };
    });

  return {
    provider: "PIN_GO_CONNECT",
    connected: true,
    connectionStatus: listing.connection.status,
    propertyId: property.id,
    propertyName: property.name,
    generatedAt: new Date().toISOString(),
    summary: {
      persistedRevisions: revisions.filter(
        (revision) => revision.persistenceStatus === "PERSISTED"
      ).length,
      acknowledgedRevisions: revisions.filter(
        (revision) => revision.acknowledgementStatus === "SENT"
      ).length,
      pendingRevisions:
        revisions.filter(
          (revision) =>
            revision.acknowledgementStatus !== "SENT" ||
            revision.persistenceStatus === "PENDING"
        ).length + unresolvedEvents.length,
      recoverableErrors:
        revisions.filter((revision) => revision.recoverable).length +
        unresolvedEvents.filter((event) => event.recoverable).length,
      hostActionRequired:
        revisions.filter((revision) => revision.hostActionRequired).length +
        unresolvedEvents.filter((event) => event.hostActionRequired).length,
      recoveryExhausted:
        revisions.filter(
          (revision) => revision.nextAutomaticAction === "RECOVERY_EXHAUSTED"
        ).length +
        unresolvedEvents.filter(
          (event) => event.nextAutomaticAction === "RECOVERY_EXHAUSTED"
        ).length,
    },
    revisions,
    unresolvedEvents,
  };
}
