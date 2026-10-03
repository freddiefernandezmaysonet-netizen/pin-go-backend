import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { checkPropertyAvailability } from "./availability.service";
import { upsertOperationalIssue } from "../apms/operational-intelligence.service";

/** External bookings are operational truth: record a conflict, never reject or undo them. */
export async function recordChannexAvailabilityConflict(tx: Prisma.TransactionClient, input: {
  reservationId: string; revision: string | null;
}) {
  const reservation = await tx.reservation.findUniqueOrThrow({ where: { id: input.reservationId }, select: {
    id: true, reservationNumber: true, guestName: true, propertyId: true, status: true,
    externalProvider: true, checkIn: true, checkOut: true,
    property: { select: { organizationId: true } },
  } });
  if (reservation.externalProvider !== "CHANNEX" || reservation.status !== "ACTIVE") return null;
  const availability = await checkPropertyAvailability({ propertyId: reservation.propertyId,
    checkIn: reservation.checkIn, checkOut: reservation.checkOut, excludeReservationId: reservation.id }, tx);
  if (availability.available) return null;
  const conflict = JSON.parse(JSON.stringify(availability.conflict)) as Record<string, unknown>;
  // A replay cannot reopen a host-resolved issue or duplicate its transition.
  // A different provider revision retains separate evidence for renewed review.
  const signature = createHash("sha256").update(JSON.stringify({ revision: input.revision,
    checkIn: reservation.checkIn.toISOString(), checkOut: reservation.checkOut.toISOString(), conflict })).digest("hex");
  const operationalKey = `CHANNEX_AVAILABILITY_CONFLICT:${reservation.id}:${signature}`;
  const existing = await tx.operationalIssue.findUnique({ where: { operationalKey } });
  if (existing) return existing;
  return upsertOperationalIssue(tx, {
    operationalKey, issueCode: "CHANNEX_AVAILABILITY_CONFLICT", engine: "Reservation",
    title: "Confirmed OTA booking requires availability review",
    issue: "A confirmed Channex reservation conflicts with occupancy, a pending change, cleaning or a blocked date.",
    operationalImpact: "The OTA reservation was preserved. Both guest commitments need host review before further changes.",
    recommendedAction: "Review both reservations and the cleaning schedule. Coordinate the solution with affected guests and the OTA; no reservation was cancelled or reverted automatically.",
    nextAutomaticStep: null, severity: "CRITICAL", workflowState: "ACTION_REQUIRED", visibility: "HOST",
    responsibleActor: "HOST", actionRequired: true, canAutoResolve: false, autoResolveStatus: "NOT_SUPPORTED",
    autoResolveActionCode: null, reservationId: reservation.id, reservationNumber: reservation.reservationNumber,
    propertyId: reservation.propertyId, organizationId: reservation.property.organizationId, guestName: reservation.guestName,
    sourceType: "ENGINE_EVENT", actionTarget: "RESERVATION",
    transitionCode: "CHANNEX_AVAILABILITY_CONFLICT_DETECTED",
    transitionSummary: "Pin&Go preserved the OTA booking and requested host review of conflicting availability.",
    transitionedBy: "PIN_GO", metadata: { version: "channex_availability_conflict_v1", revision: input.revision,
      incomingCheckIn: reservation.checkIn.toISOString(), incomingCheckOut: reservation.checkOut.toISOString(),
      conflict, reservationPreserved: true, automaticCancellation: false, automaticRollback: false },
  });
}
