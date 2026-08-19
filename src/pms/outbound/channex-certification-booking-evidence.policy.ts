import type {
  ChannexCertificationManifest,
} from "./channex-certification-manifest.policy";
import {
  certifyChannexBookingReceivingScenario,
  type ChannexCertificationBookingLifecycle,
} from "./channex-certification-booking-receiving.policy";
import {
  buildChannexCertificationEvidence,
} from "../../services/channex-certification-evidence.policy";

type CollectedChannexRevisionEvidence = ReturnType<
  typeof buildChannexCertificationEvidence
>;

export type ChannexBookingWebhookDeliveryEvidence = {
  httpStatus: number;
  notesSuccess: boolean;
};

export type ChannexBookingLifecycleEvidence = {
  lifecycle: ChannexCertificationBookingLifecycle;
  collected: CollectedChannexRevisionEvidence;
  webhookDelivery: ChannexBookingWebhookDeliveryEvidence;
};

export function certifyCollectedChannexBookingEvidence(args: {
  manifest: ChannexCertificationManifest;
  revisions: ChannexBookingLifecycleEvidence[];
}) {
  for (const revision of args.revisions) {
    if (revision.collected.outcome !== "PASS") {
      throw new Error(
        `CHANNEX_CERTIFICATION_BOOKING_EVIDENCE_NOT_PASS:${revision.lifecycle}:${revision.collected.outcome}`
      );
    }
  }

  return certifyChannexBookingReceivingScenario({
    pinGoPropertyId: args.manifest.propertyId,
    channexPropertyId: args.manifest.channexPropertyId,
    revisions: args.revisions.map((revision) => ({
      lifecycle: revision.lifecycle,
      revisionId: revision.collected.revision.revisionId,
      bookingId: revision.collected.revision.bookingId ?? "",
      pinGoReservationId:
        revision.collected.reservation?.reservationId ?? "",
      pinGoPropertyId: revision.collected.revision.propertyId ?? "",
      channexPropertyId:
        revision.collected.revision.channexPropertyId ?? "",
      externalProvider:
        revision.collected.reservation?.externalProvider ?? "",
      reservationStatus: revision.collected.reservation?.status ?? "",
      reservationCountForBooking:
        revision.collected.reservation?.reservationCountForBooking ?? 0,
      ingestMechanism: revision.collected.ingest.mechanism,
      webhookHttpStatus: revision.webhookDelivery.httpStatus,
      webhookDeliveryNotesSuccess: revision.webhookDelivery.notesSuccess,
      eventStatus: revision.collected.event?.status ?? "",
      persistenceStatus: revision.collected.persistence?.status ?? "",
      persistenceCompletedAt:
        revision.collected.persistence?.completedAt ?? "",
      acknowledgementStatus:
        revision.collected.acknowledgement?.status ?? "",
      acknowledgementStartedAt:
        revision.collected.acknowledgement?.startedAt ?? "",
    })),
  });
}
