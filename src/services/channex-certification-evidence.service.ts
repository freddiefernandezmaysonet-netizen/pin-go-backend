import { PmsProvider } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { getDistributionLifecycleSnapshot } from "../apms/distribution-lifecycle-read-model.service";
import {
  buildChannexCertificationEvidence,
  toPublicChannexErrorCode,
} from "./channex-certification-evidence.policy";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown) {
  const normalized = String(value ?? "").trim();
  return normalized.length > 0 ? normalized : null;
}

function toIso(value: Date | null | undefined) {
  return value?.toISOString() ?? null;
}

export async function collectChannexCertificationEvidence(args: {
  revisionId: string;
}) {
  const revisionId = String(args.revisionId ?? "").trim();

  if (!revisionId) {
    throw new Error("CHANNEX_REVISION_ID_REQUIRED");
  }

  const persistenceDecisionId =
    `distribution-engine:channex-revision:${revisionId}:persisted`;
  const acknowledgementDecisionId =
    `distribution-engine:channex-revision:${revisionId}:ack`;

  const [persistenceAudit, acknowledgementAudit] = await Promise.all([
    prisma.apmsAuditEntry.findUnique({
      where: { decisionId: persistenceDecisionId },
      select: {
        status: true,
        reason: true,
        metadata: true,
        completedAt: true,
        createdAt: true,
      },
    }),
    prisma.apmsAuditEntry.findUnique({
      where: { decisionId: acknowledgementDecisionId },
      select: {
        status: true,
        reason: true,
        metadata: true,
        completedAt: true,
        createdAt: true,
      },
    }),
  ]);

  if (!persistenceAudit && !acknowledgementAudit) {
    throw new Error(`CHANNEX_REVISION_EVIDENCE_NOT_FOUND:${revisionId}`);
  }

  const persistenceMetadata = asRecord(persistenceAudit?.metadata);
  const acknowledgementMetadata = asRecord(acknowledgementAudit?.metadata);
  const metadata =
    Object.keys(persistenceMetadata).length > 0
      ? persistenceMetadata
      : acknowledgementMetadata;

  const bookingId = asString(metadata.bookingId);
  const bookingReference =
    asString(metadata.otaReservationCode) ??
    asString(metadata.bookingUniqueId) ??
    bookingId;
  const channexPropertyId = asString(metadata.channexPropertyId);
  const propertyId = asString(metadata.propertyId);
  const webhookEventId = asString(metadata.webhookEventId);
  const insertedAt = asString(metadata.insertedAt);

  const [event, reservation] = await Promise.all([
    webhookEventId
      ? prisma.webhookEventIngest.findUnique({
          where: { id: webhookEventId },
          select: {
            eventType: true,
            status: true,
            attempts: true,
            lastError: true,
            receivedAt: true,
            processedAt: true,
            updatedAt: true,
          },
        })
      : Promise.resolve(null),
    propertyId && bookingId
      ? prisma.reservation.findUnique({
          where: {
            propertyId_externalProvider_externalId: {
              propertyId,
              externalProvider: "CHANNEX",
              externalId: bookingId,
            },
          },
          select: {
            reservationNumber: true,
            status: true,
            externalProvider: true,
            externalId: true,
            externalUpdatedAt: true,
            lastIngestError: true,
            checkIn: true,
            checkOut: true,
            paymentState: true,
            createdAt: true,
            updatedAt: true,
          },
        })
      : Promise.resolve(null),
  ]);

  let missionControl = null;

  if (propertyId) {
    const connection = await prisma.pmsConnection.findFirst({
      where: {
        provider: PmsProvider.CHANNEX,
        status: "ACTIVE",
        listings: {
          some: { propertyId },
        },
      },
      select: { organizationId: true },
    });

    if (connection) {
      const snapshot = await getDistributionLifecycleSnapshot({
        organizationId: connection.organizationId,
        propertyId,
      });
      const revision = snapshot.revisions.find(
        (item) => item.revisionId === revisionId
      );

      if (revision) {
        missionControl = {
          persistenceStatus: revision.persistenceStatus,
          acknowledgementStatus: revision.acknowledgementStatus,
          eventStatus: revision.eventStatus,
          nextAutomaticAction: revision.nextAutomaticAction,
          recoverable: revision.recoverable,
          hostActionRequired: revision.hostActionRequired,
        };
      }
    }
  }

  return buildChannexCertificationEvidence({
    revisionId,
    bookingId,
    bookingReference,
    channexPropertyId,
    insertedAt,
    propertyId,
    persistence: persistenceAudit
      ? {
          status: persistenceAudit.status,
          reason: persistenceAudit.reason,
          completedAt: toIso(
            persistenceAudit.completedAt ?? persistenceAudit.createdAt
          ),
        }
      : null,
    acknowledgement: acknowledgementAudit
      ? {
          status: acknowledgementAudit.status,
          reason: acknowledgementAudit.reason,
          completedAt: toIso(
            acknowledgementAudit.completedAt ?? acknowledgementAudit.createdAt
          ),
        }
      : null,
    event: event
      ? {
          eventType: event.eventType,
          status: event.status,
          attempts: event.attempts,
          lastErrorCode: toPublicChannexErrorCode(event.lastError),
          receivedAt: toIso(event.receivedAt),
          processedAt: toIso(event.processedAt),
          updatedAt: toIso(event.updatedAt),
        }
      : null,
    reservation: reservation
      ? {
          reservationNumber: reservation.reservationNumber,
          status: reservation.status,
          externalProvider: reservation.externalProvider,
          externalId: reservation.externalId,
          externalUpdatedAt: toIso(reservation.externalUpdatedAt),
          lastIngestErrorCode: asString(reservation.lastIngestError)?.split(":")[0] ?? null,
          checkIn: toIso(reservation.checkIn),
          checkOut: toIso(reservation.checkOut),
          paymentState: reservation.paymentState,
          createdAt: toIso(reservation.createdAt),
          updatedAt: toIso(reservation.updatedAt),
        }
      : null,
    missionControl,
  });
}
