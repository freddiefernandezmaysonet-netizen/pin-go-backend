import { PmsProvider } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { persistAuditEntry } from "../../apms/audit-persistence.service";
import type { AuditEntry } from "../../apms/audit-types";
import { ingestReservation } from "../../services/ingest.service";
import { getAdapter } from "../adapters";
import type {
  ChannexBookingRevision,
  ParseWebhookResult,
} from "../adapters/types";

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

function resolvePaymentState(revision: ChannexBookingRevision): "PAID" | "NONE" {
  const raw = asRecord(revision.reservation.raw);
  const paymentCollect = String(raw.payment_collect ?? "")
    .trim()
    .toLowerCase();
  const amount = Number(raw.amount ?? 0);

  return paymentCollect === "ota" && Number.isFinite(amount) && amount > 0
    ? "PAID"
    : "NONE";
}

function resolveReservationSource(revision: ChannexBookingRevision) {
  const raw = asRecord(revision.reservation.raw);
  return asString(raw.ota_name) ?? "PIN_GO_CONNECT";
}

function buildRevisionMetadata(args: {
  organizationId: string;
  propertyId: string;
  reservationId?: string | null;
  eventId: string;
  revision: ChannexBookingRevision;
}) {
  return {
    organizationId: args.organizationId,
    propertyId: args.propertyId,
    reservationId: args.reservationId ?? undefined,
    provider: "CHANNEX",
    publicProviderName: "PIN_GO_CONNECT",
    webhookEventId: args.eventId,
    revisionId: args.revision.identity.revisionId,
    bookingId: args.revision.identity.bookingId,
    bookingUniqueId: args.revision.identity.bookingUniqueId ?? null,
    otaReservationCode: args.revision.identity.otaReservationCode ?? null,
    channexPropertyId: args.revision.identity.propertyId,
    liveFeedEventId: args.revision.identity.liveFeedEventId ?? null,
    systemId: args.revision.identity.systemId ?? null,
    insertedAt: args.revision.identity.insertedAt ?? null,
  };
}

async function persistLifecycleAudit(args: {
  decisionId: string;
  eventType: AuditEntry["eventType"];
  status: AuditEntry["status"];
  severity: AuditEntry["severity"];
  summary: string;
  reason: string;
  startedAt: Date;
  completedAt: Date;
  organizationId: string;
  propertyId: string;
  reservationId?: string | null;
  eventId: string;
  revision: ChannexBookingRevision;
  applied: boolean;
  rule: string;
  label: string;
  recommendedAction?: string;
}) {
  await persistAuditEntry(prisma, {
    engine: "Distribution",
    decisionId: args.decisionId,
    entityType: "DISTRIBUTION",
    entityId: args.revision.identity.revisionId,
    eventType: args.eventType,
    status: args.status,
    severity: args.severity,
    summary: args.summary,
    startedAt: args.startedAt,
    completedAt: args.completedAt,
    durationMs: args.completedAt.getTime() - args.startedAt.getTime(),
    reason: args.reason,
    decisions: [
      {
        engine: "Distribution",
        rule: args.rule,
        label: args.label,
        applied: args.applied,
        confidence: 100,
        adjustment: null,
        adjustmentPercent: null,
        metadata: buildRevisionMetadata({
          organizationId: args.organizationId,
          propertyId: args.propertyId,
          reservationId: args.reservationId,
          eventId: args.eventId,
          revision: args.revision,
        }),
      },
    ],
    ...(args.recommendedAction
      ? { recommendedAction: args.recommendedAction }
      : {}),
    metadata: buildRevisionMetadata({
      organizationId: args.organizationId,
      propertyId: args.propertyId,
      reservationId: args.reservationId,
      eventId: args.eventId,
      revision: args.revision,
    }),
  });
}

async function resolveListing(args: {
  connectionId: string;
  revision: ChannexBookingRevision;
}) {
  const byRoomType = await prisma.pmsListing.findUnique({
    where: {
      connectionId_externalListingId: {
        connectionId: args.connectionId,
        externalListingId: args.revision.reservation.externalListingId,
      },
    },
  });

  const listing =
    byRoomType ??
    (await prisma.pmsListing.findFirst({
      where: {
        connectionId: args.connectionId,
        metadata: {
          path: ["channexPropertyId"],
          equals: args.revision.identity.propertyId,
        },
      },
    }));

  if (!listing) {
    throw new Error(
      `CHANNEX_LISTING_MAPPING_NOT_FOUND:${args.revision.identity.propertyId}:${args.revision.reservation.externalListingId}`
    );
  }

  if (!listing.propertyId) {
    throw new Error(`CHANNEX_LISTING_NEEDS_PROPERTY_MAPPING:${listing.id}`);
  }

  const metadata = asRecord(listing.metadata);
  const mappedChannexPropertyId = asString(metadata.channexPropertyId);

  if (
    mappedChannexPropertyId &&
    mappedChannexPropertyId !== args.revision.identity.propertyId
  ) {
    throw new Error(
      `CHANNEX_PROPERTY_MAPPING_MISMATCH:${mappedChannexPropertyId}:${args.revision.identity.propertyId}`
    );
  }

  return listing;
}

async function getRevisions(args: {
  parsed: ParseWebhookResult;
  connection: {
    id: string;
    credentialsEncrypted: string | null;
    metadata: unknown;
  };
}) {
  const adapter = getAdapter(PmsProvider.CHANNEX);

  if (
    !adapter.fetchBookingRevision ||
    !adapter.fetchBookingRevisionFeed ||
    !adapter.acknowledgeBookingRevision
  ) {
    throw new Error("CHANNEX_BOOKING_LIFECYCLE_ADAPTER_INCOMPLETE");
  }

  const connection = {
    id: args.connection.id,
    credentialsEncrypted: args.connection.credentialsEncrypted,
    metadata: args.connection.metadata,
  };
  const revisionId = asString(args.parsed.bookingRevision?.revisionId);
  const propertyId = asString(args.parsed.bookingRevision?.propertyId);

  if (revisionId) {
    return {
      adapter,
      connection,
      revisions: [
        await adapter.fetchBookingRevision({
          connection,
          revisionId,
        }),
      ],
    };
  }

  if (!propertyId) {
    throw new Error("CHANNEX_PROPERTY_ID_REQUIRED_FOR_FEED_RECOVERY");
  }

  const feed = await adapter.fetchBookingRevisionFeed({ connection });
  const revisions = feed.filter(
    (revision) => revision.identity.propertyId === propertyId
  );

  if (revisions.length === 0) {
    throw new Error(`CHANNEX_FEED_NO_PENDING_REVISIONS:${propertyId}`);
  }

  return {
    adapter,
    connection,
    revisions,
  };
}

async function processRevision(args: {
  eventId: string;
  organizationId: string;
  connectionId: string;
  revision: ChannexBookingRevision;
  acknowledge: (revisionId: string) => Promise<void>;
}) {
  const lifecycleStartedAt = new Date();
  const listing = await resolveListing({
    connectionId: args.connectionId,
    revision: args.revision,
  });
  const insertedAt = new Date(args.revision.identity.insertedAt ?? "");

  if (Number.isNaN(insertedAt.getTime())) {
    throw new Error(
      `CHANNEX_REVISION_INVALID_INSERTED_AT:${args.revision.identity.revisionId}`
    );
  }

  const existingReservation = await prisma.reservation.findUnique({
    where: {
      propertyId_externalProvider_externalId: {
        propertyId: listing.propertyId!,
        externalProvider: "CHANNEX",
        externalId: args.revision.identity.bookingId,
      },
    },
    select: {
      id: true,
      externalUpdatedAt: true,
    },
  });

  let reservationId = existingReservation?.id ?? null;
  const isOlderOrSame = Boolean(
    existingReservation?.externalUpdatedAt &&
      insertedAt.getTime() <= existingReservation.externalUpdatedAt.getTime()
  );

  if (isOlderOrSame) {
    const completedAt = new Date();

    await persistLifecycleAudit({
      decisionId: `distribution-engine:channex-revision:${args.revision.identity.revisionId}:persisted`,
      eventType: "DECISION_SKIPPED",
      status: "SKIPPED",
      severity: "INFO",
      summary:
        "Pin&Go Connect ignored an older or already persisted booking revision.",
      reason: "CHANNEX_REVISION_SUPERSEDED_OR_ALREADY_PERSISTED",
      startedAt: lifecycleStartedAt,
      completedAt,
      organizationId: args.organizationId,
      propertyId: listing.propertyId!,
      reservationId,
      eventId: args.eventId,
      revision: args.revision,
      applied: false,
      rule: "CHANNEX_REVISION_CHRONOLOGY_GUARD",
      label: "Booking Revision Chronology Guard",
    });
  } else {
    const result = await ingestReservation({
      source: resolveReservationSource(args.revision),
      propertyId: listing.propertyId!,
      guestName: args.revision.reservation.guest?.name ?? "Guest",
      guestEmail: args.revision.reservation.guest?.email ?? null,
      guestPhone: args.revision.reservation.guest?.phone ?? null,
      roomName: listing.name ?? args.revision.reservation.listingName ?? null,
      checkIn: args.revision.reservation.checkIn,
      checkOut: args.revision.reservation.checkOut,
      paymentState: resolvePaymentState(args.revision),
      externalProvider: "CHANNEX",
      externalId: args.revision.identity.bookingId,
      externalUpdatedAt: insertedAt.toISOString(),
      externalRaw: {
        provider: "CHANNEX",
        publicProviderName: "PIN_GO_CONNECT",
        revisionIdentity: args.revision.identity,
        booking: args.revision.reservation.raw,
      },
      status:
        args.revision.reservation.status === "CANCELLED"
          ? "CANCELLED"
          : "ACTIVE",
    });

    reservationId = result.reservationId;

    const persistedReservation = await prisma.reservation.findUnique({
      where: { id: result.reservationId },
      select: {
        id: true,
        status: true,
        lastIngestError: true,
        externalUpdatedAt: true,
      },
    });

    if (!persistedReservation) {
      throw new Error(
        `CHANNEX_RESERVATION_NOT_FOUND_AFTER_INGEST:${result.reservationId}`
      );
    }

    const cancellationRejected =
      args.revision.reservation.status === "CANCELLED" &&
      persistedReservation.lastIngestError === "CANCEL_REJECTED_ACTIVE_STAY";

    if (cancellationRejected) {
      const completedAt = new Date();

      await persistLifecycleAudit({
        decisionId: `distribution-engine:channex-revision:${args.revision.identity.revisionId}:persisted`,
        eventType: "ACTION_FAILED",
        status: "FAILED",
        severity: "CRITICAL",
        summary:
          "Pin&Go Connect could not apply the booking cancellation to the active stay.",
        reason: "CHANNEX_CANCELLATION_NOT_APPLIED",
        startedAt: lifecycleStartedAt,
        completedAt,
        organizationId: args.organizationId,
        propertyId: listing.propertyId!,
        reservationId,
        eventId: args.eventId,
        revision: args.revision,
        applied: false,
        rule: "CHANNEX_BOOKING_CANCELLATION_PERSISTENCE",
        label: "Pin&Go Connect Booking Cancellation",
        recommendedAction:
          "Review the active stay cancellation before acknowledging the channel revision.",
      });

      throw new Error(
        `CHANNEX_CANCELLATION_NOT_APPLIED:${args.revision.identity.revisionId}`
      );
    }

    const completedAt = new Date();

    await persistLifecycleAudit({
      decisionId: `distribution-engine:channex-revision:${args.revision.identity.revisionId}:persisted`,
      eventType: "ACTION_COMPLETED",
      status: "SUCCESS",
      severity: "INFO",
      summary: "Pin&Go Connect persisted the booking revision successfully.",
      reason: result.didChange
        ? "CHANNEX_REVISION_PERSISTED"
        : "CHANNEX_REVISION_ALREADY_CURRENT",
      startedAt: lifecycleStartedAt,
      completedAt,
      organizationId: args.organizationId,
      propertyId: listing.propertyId!,
      reservationId,
      eventId: args.eventId,
      revision: args.revision,
      applied: result.didChange,
      rule: "CHANNEX_BOOKING_REVISION_PERSISTENCE",
      label: "Pin&Go Connect Booking Persistence",
    });
  }

  const ackStartedAt = new Date();

  try {
    await args.acknowledge(args.revision.identity.revisionId);
  } catch (error: any) {
    const ackCompletedAt = new Date();
    const ackError = String(error?.message ?? error);

    try {
      await persistLifecycleAudit({
        decisionId: `distribution-engine:channex-revision:${args.revision.identity.revisionId}:ack`,
        eventType: "ACTION_FAILED",
        status: "FAILED",
        severity: "WARNING",
        summary:
          "Pin&Go Connect persisted the booking revision but could not acknowledge it.",
        reason: "CHANNEX_REVISION_ACK_FAILED",
        startedAt: ackStartedAt,
        completedAt: ackCompletedAt,
        organizationId: args.organizationId,
        propertyId: listing.propertyId!,
        reservationId,
        eventId: args.eventId,
        revision: args.revision,
        applied: false,
        rule: "CHANNEX_BOOKING_REVISION_ACK",
        label: "Pin&Go Connect Booking Acknowledgement",
        recommendedAction:
          "Pin&Go will retry the booking acknowledgement automatically.",
      });
    } catch (auditError: any) {
      console.error("[CHANNEX_ACK_AUDIT_PERSIST_FAILED]", {
        revisionId: args.revision.identity.revisionId,
        eventId: args.eventId,
        error: String(auditError?.message ?? auditError),
      });
    }

    throw new Error(
      `CHANNEX_REVISION_ACK_FAILED:${args.revision.identity.revisionId}:${ackError}`
    );
  }

  const ackCompletedAt = new Date();

  await persistLifecycleAudit({
    decisionId: `distribution-engine:channex-revision:${args.revision.identity.revisionId}:ack`,
    eventType: "ACTION_COMPLETED",
    status: "SUCCESS",
    severity: "INFO",
    summary: "Pin&Go Connect acknowledged the persisted booking revision.",
    reason: "CHANNEX_REVISION_ACKNOWLEDGED",
    startedAt: ackStartedAt,
    completedAt: ackCompletedAt,
    organizationId: args.organizationId,
    propertyId: listing.propertyId!,
    reservationId,
    eventId: args.eventId,
    revision: args.revision,
    applied: true,
    rule: "CHANNEX_BOOKING_REVISION_ACK",
    label: "Pin&Go Connect Booking Acknowledgement",
  });
}

export async function processChannexBookingWebhookEventById(eventId: string) {
  const claimed = await prisma.webhookEventIngest.updateMany({
    where: {
      id: eventId,
      provider: PmsProvider.CHANNEX,
      status: { in: ["PENDING", "FAILED"] },
    },
    data: {
      status: "PROCESSING",
      attempts: { increment: 1 },
      lastError: null,
    },
  });

  if (claimed.count !== 1) {
    return { claimed: false };
  }

  try {
    const event = await prisma.webhookEventIngest.findUnique({
      where: { id: eventId },
      include: {
        connection: {
          select: {
            id: true,
            organizationId: true,
            provider: true,
            status: true,
            credentialsEncrypted: true,
            metadata: true,
          },
        },
      },
    });

    if (!event) throw new Error("CHANNEX_WEBHOOK_EVENT_NOT_FOUND");
    if (event.connection.provider !== PmsProvider.CHANNEX) {
      throw new Error("CHANNEX_CONNECTION_PROVIDER_MISMATCH");
    }
    if (event.connection.status !== "ACTIVE") {
      throw new Error(
        `CHANNEX_CONNECTION_NOT_ACTIVE:${event.connection.status}`
      );
    }

    const adapter = getAdapter(PmsProvider.CHANNEX);
    const parsed = adapter.parseWebhook({
      headers: {},
      body: event.payloadRaw,
    });
    const lifecycle = await getRevisions({
      parsed,
      connection: event.connection,
    });
    const revisions = [...lifecycle.revisions].sort((left, right) => {
      const leftTime = new Date(left.identity.insertedAt ?? "").getTime();
      const rightTime = new Date(right.identity.insertedAt ?? "").getTime();
      return leftTime - rightTime;
    });

    for (const revision of revisions) {
      await processRevision({
        eventId: event.id,
        organizationId: event.connection.organizationId,
        connectionId: event.connection.id,
        revision,
        acknowledge: async (revisionId) => {
          await lifecycle.adapter.acknowledgeBookingRevision!({
            connection: lifecycle.connection,
            revisionId,
          });
        },
      });
    }

    await prisma.webhookEventIngest.update({
      where: { id: event.id },
      data: {
        status: "PROCESSED",
        processedAt: new Date(),
        lastError: null,
      },
    });

    return {
      claimed: true,
      processed: true,
      revisionCount: revisions.length,
    };
  } catch (error: any) {
    const message = String(error?.message ?? error);

    await prisma.webhookEventIngest.update({
      where: { id: eventId },
      data: {
        status: "FAILED",
        lastError: message,
      },
    });

    throw error;
  }
}
