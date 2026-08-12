export type ChannexCertificationAuditEvidence = {
  status: string | null;
  reason: string | null;
  completedAt: string | null;
};

export type ChannexCertificationEventEvidence = {
  eventType: string | null;
  status: string | null;
  attempts: number;
  lastErrorCode: string | null;
  receivedAt: string | null;
  processedAt: string | null;
  updatedAt: string | null;
};

export type ChannexCertificationReservationEvidence = {
  reservationNumber: string | null;
  status: string | null;
  externalProvider: string | null;
  externalId: string | null;
  externalUpdatedAt: string | null;
  lastIngestErrorCode: string | null;
  checkIn: string | null;
  checkOut: string | null;
  paymentState: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

export type ChannexCertificationEvidenceInput = {
  revisionId: string;
  bookingId: string | null;
  bookingReference: string | null;
  channexPropertyId: string | null;
  insertedAt: string | null;
  propertyId: string | null;
  persistence: ChannexCertificationAuditEvidence | null;
  acknowledgement: ChannexCertificationAuditEvidence | null;
  event: ChannexCertificationEventEvidence | null;
  reservation: ChannexCertificationReservationEvidence | null;
  missionControl: {
    persistenceStatus: string | null;
    acknowledgementStatus: string | null;
    eventStatus: string | null;
    nextAutomaticAction: string | null;
    recoverable: boolean;
    hostActionRequired: boolean;
  } | null;
};

function normalize(value: unknown) {
  const normalized = String(value ?? "").trim();
  return normalized.length > 0 ? normalized : null;
}

export function toPublicChannexErrorCode(value: unknown) {
  const message = normalize(value);
  if (!message) return null;

  const code = message.split(":")[0] ?? message;
  return code.replace(/^CHANNEX_/, "PIN_GO_CONNECT_");
}

export function buildChannexCertificationEvidence(
  input: ChannexCertificationEvidenceInput
) {
  const persistenceStatus = normalize(input.persistence?.status);
  const acknowledgementStatus = normalize(input.acknowledgement?.status);
  const eventStatus = normalize(input.event?.status);
  const reservationProvider = normalize(input.reservation?.externalProvider);
  const reservationExternalId = normalize(input.reservation?.externalId);
  const reservationUpdatedAt = normalize(input.reservation?.externalUpdatedAt);

  const persistenceAccepted =
    persistenceStatus === "SUCCESS" || persistenceStatus === "SKIPPED";
  const acknowledgementSent = acknowledgementStatus === "SUCCESS";
  const reservationMatches =
    Boolean(input.reservation) &&
    reservationProvider === "CHANNEX" &&
    reservationExternalId === normalize(input.bookingId) &&
    Boolean(reservationUpdatedAt);
  const eventTerminal = eventStatus === "PROCESSED";
  const cancellationRejected =
    input.persistence?.reason === "CHANNEX_CANCELLATION_NOT_APPLIED";
  const acknowledgementFailed =
    input.acknowledgement?.reason === "CHANNEX_REVISION_ACK_FAILED";

  let outcome:
    | "PASS"
    | "PASS_SUPERSEDED"
    | "PENDING_AUTOMATIC_RECOVERY"
    | "ACTION_REQUIRED"
    | "FAIL_INCOMPLETE";

  if (
    cancellationRejected ||
    input.missionControl?.hostActionRequired === true
  ) {
    outcome = "ACTION_REQUIRED";
  } else if (
    acknowledgementFailed ||
    input.missionControl?.recoverable === true
  ) {
    outcome = "PENDING_AUTOMATIC_RECOVERY";
  } else if (
    persistenceStatus === "SKIPPED" &&
    acknowledgementSent &&
    eventTerminal
  ) {
    outcome = "PASS_SUPERSEDED";
  } else if (
    persistenceAccepted &&
    acknowledgementSent &&
    eventTerminal &&
    reservationMatches
  ) {
    outcome = "PASS";
  } else {
    outcome = "FAIL_INCOMPLETE";
  }

  return {
    provider: "PIN_GO_CONNECT",
    revision: {
      revisionId: input.revisionId,
      bookingId: input.bookingId,
      bookingReference: input.bookingReference,
      channexPropertyId: input.channexPropertyId,
      insertedAt: input.insertedAt,
      propertyId: input.propertyId,
    },
    persistence: input.persistence,
    acknowledgement: input.acknowledgement,
    event: input.event,
    reservation: input.reservation,
    missionControl: input.missionControl,
    verification: {
      persistenceAccepted,
      acknowledgementSent,
      eventTerminal,
      reservationMatches,
      cancellationRejected,
      acknowledgementFailed,
    },
    outcome,
    complete: outcome !== "FAIL_INCOMPLETE",
  };
}
