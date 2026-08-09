import {
  requireAllowedChannexBookingIngestMechanism,
} from "../ingest/channex-booking-ingest-mechanism.policy";

export type ChannexCertificationBookingLifecycle =
  | "NEW"
  | "MODIFICATION"
  | "CANCELLATION";

export type ChannexCertificationBookingRevisionEvidence = {
  lifecycle: ChannexCertificationBookingLifecycle;
  revisionId: string;
  bookingId: string;
  pinGoReservationId: string;
  pinGoPropertyId: string;
  channexPropertyId: string;
  externalProvider: string;
  reservationStatus: string;
  reservationCountForBooking: number;
  ingestMechanism: string;
  webhookHttpStatus: number;
  webhookDeliveryNotesSuccess: boolean;
  eventStatus: string;
  persistenceStatus: string;
  persistenceCompletedAt: string;
  acknowledgementStatus: string;
  acknowledgementStartedAt: string;
};

const REQUIRED_LIFECYCLES = [
  "NEW",
  "MODIFICATION",
  "CANCELLATION",
] as const;

const EXPECTED_RESERVATION_STATUS = {
  NEW: "ACTIVE",
  MODIFICATION: "ACTIVE",
  CANCELLATION: "CANCELLED",
} as const;

function requireValue(value: unknown, field: string) {
  const normalized = String(value ?? "").trim();

  if (!normalized) {
    throw new Error(`CHANNEX_CERTIFICATION_BOOKING_FIELD_REQUIRED:${field}`);
  }

  return normalized;
}

function requireTimestamp(value: unknown, field: string) {
  const normalized = requireValue(value, field);
  const timestamp = Date.parse(normalized);

  if (!Number.isFinite(timestamp)) {
    throw new Error(`CHANNEX_CERTIFICATION_BOOKING_TIMESTAMP_INVALID:${field}`);
  }

  return timestamp;
}

export function certifyChannexBookingReceivingScenario(args: {
  pinGoPropertyId: string;
  channexPropertyId: string;
  revisions: ChannexCertificationBookingRevisionEvidence[];
}) {
  const pinGoPropertyId = requireValue(
    args.pinGoPropertyId,
    "pinGoPropertyId"
  );
  const channexPropertyId = requireValue(
    args.channexPropertyId,
    "channexPropertyId"
  );

  if (args.revisions.length !== REQUIRED_LIFECYCLES.length) {
    throw new Error(
      `CHANNEX_CERTIFICATION_BOOKING_REVISION_COUNT_MISMATCH:${args.revisions.length}`
    );
  }

  const revisionsByLifecycle = new Map<
    ChannexCertificationBookingLifecycle,
    ChannexCertificationBookingRevisionEvidence
  >();

  for (const revision of args.revisions) {
    if (revisionsByLifecycle.has(revision.lifecycle)) {
      throw new Error(
        `CHANNEX_CERTIFICATION_BOOKING_LIFECYCLE_DUPLICATE:${revision.lifecycle}`
      );
    }

    revisionsByLifecycle.set(revision.lifecycle, revision);
  }

  const orderedRevisions = REQUIRED_LIFECYCLES.map((lifecycle) => {
    const revision = revisionsByLifecycle.get(lifecycle);

    if (!revision) {
      throw new Error(
        `CHANNEX_CERTIFICATION_BOOKING_LIFECYCLE_MISSING:${lifecycle}`
      );
    }

    return revision;
  });

  const bookingIds = new Set<string>();
  const reservationIds = new Set<string>();
  const revisionIds = new Set<string>();

  for (const revision of orderedRevisions) {
    const lifecycle = revision.lifecycle;
    const revisionId = requireValue(
      revision.revisionId,
      `${lifecycle}.revisionId`
    );
    const bookingId = requireValue(revision.bookingId, `${lifecycle}.bookingId`);
    const reservationId = requireValue(
      revision.pinGoReservationId,
      `${lifecycle}.pinGoReservationId`
    );

    if (revisionIds.has(revisionId)) {
      throw new Error(
        `CHANNEX_CERTIFICATION_BOOKING_REVISION_ID_DUPLICATE:${revisionId}`
      );
    }

    revisionIds.add(revisionId);
    bookingIds.add(bookingId);
    reservationIds.add(reservationId);

    if (revision.pinGoPropertyId !== pinGoPropertyId) {
      throw new Error(
        `CHANNEX_CERTIFICATION_BOOKING_PIN_GO_PROPERTY_MISMATCH:${lifecycle}`
      );
    }

    if (revision.channexPropertyId !== channexPropertyId) {
      throw new Error(
        `CHANNEX_CERTIFICATION_BOOKING_CHANNEX_PROPERTY_MISMATCH:${lifecycle}`
      );
    }

    if (revision.externalProvider !== "CHANNEX") {
      throw new Error(
        `CHANNEX_CERTIFICATION_BOOKING_PROVIDER_MISMATCH:${lifecycle}`
      );
    }

    if (
      revision.reservationStatus !== EXPECTED_RESERVATION_STATUS[lifecycle]
    ) {
      throw new Error(
        `CHANNEX_CERTIFICATION_BOOKING_STATUS_MISMATCH:${lifecycle}`
      );
    }

    if (revision.reservationCountForBooking !== 1) {
      throw new Error(
        `CHANNEX_CERTIFICATION_BOOKING_RESERVATION_COUNT_MISMATCH:${lifecycle}:${revision.reservationCountForBooking}`
      );
    }

    requireAllowedChannexBookingIngestMechanism(revision.ingestMechanism);

    if (
      !Number.isInteger(revision.webhookHttpStatus) ||
      revision.webhookHttpStatus < 200 ||
      revision.webhookHttpStatus > 299
    ) {
      throw new Error(
        `CHANNEX_CERTIFICATION_BOOKING_WEBHOOK_HTTP_FAILED:${lifecycle}:${revision.webhookHttpStatus}`
      );
    }

    if (revision.webhookDeliveryNotesSuccess !== true) {
      throw new Error(
        `CHANNEX_CERTIFICATION_BOOKING_WEBHOOK_DELIVERY_FAILED:${lifecycle}`
      );
    }

    if (revision.eventStatus !== "PROCESSED") {
      throw new Error(
        `CHANNEX_CERTIFICATION_BOOKING_EVENT_NOT_PROCESSED:${lifecycle}`
      );
    }

    if (revision.persistenceStatus !== "SUCCESS") {
      throw new Error(
        `CHANNEX_CERTIFICATION_BOOKING_PERSISTENCE_FAILED:${lifecycle}`
      );
    }

    if (revision.acknowledgementStatus !== "SUCCESS") {
      throw new Error(
        `CHANNEX_CERTIFICATION_BOOKING_ACK_FAILED:${lifecycle}`
      );
    }

    const persistenceCompletedAt = requireTimestamp(
      revision.persistenceCompletedAt,
      `${lifecycle}.persistenceCompletedAt`
    );
    const acknowledgementStartedAt = requireTimestamp(
      revision.acknowledgementStartedAt,
      `${lifecycle}.acknowledgementStartedAt`
    );

    if (persistenceCompletedAt >= acknowledgementStartedAt) {
      throw new Error(
        `CHANNEX_CERTIFICATION_BOOKING_ACK_BEFORE_PERSISTENCE:${lifecycle}`
      );
    }
  }

  if (bookingIds.size !== 1) {
    throw new Error("CHANNEX_CERTIFICATION_BOOKING_IDENTITY_MISMATCH");
  }

  if (reservationIds.size !== 1) {
    throw new Error("CHANNEX_CERTIFICATION_PIN_GO_RESERVATION_MISMATCH");
  }

  return Object.freeze({
    status: "LOCAL_CONTRACT_PASS" as const,
    bookingId: Array.from(bookingIds)[0]!,
    pinGoReservationId: Array.from(reservationIds)[0]!,
    revisionIds: Object.freeze(orderedRevisions.map((item) => item.revisionId)),
    lifecycles: REQUIRED_LIFECYCLES,
    bookingFindEvents: 0 as const,
    duplicateReservations: 0 as const,
    persistenceBeforeAcknowledgement: true as const,
    webhookDeliverySuccess: true as const,
  });
}
