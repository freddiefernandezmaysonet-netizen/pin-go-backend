import { PrismaClient, ReservationStatus } from "@prisma/client";
import { upsertOperationalIssue } from "../apms/operational-intelligence.service";

export type GuestContactRecoveryState =
  | "COMPLETE"
  | "EMAIL_MISSING"
  | "PHONE_MISSING"
  | "BOTH_MISSING";

function present(value: string | null | undefined) {
  return Boolean(String(value ?? "").trim());
}

export function classifyGuestContact(input: {
  guestEmail?: string | null;
  guestPhone?: string | null;
}): GuestContactRecoveryState {
  const email = present(input.guestEmail);
  const phone = present(input.guestPhone);
  if (email && phone) return "COMPLETE";
  if (!email && !phone) return "BOTH_MISSING";
  return email ? "PHONE_MISSING" : "EMAIL_MISSING";
}

export function guestContactRecoveryOperationalKey(reservationId: string) {
  return `GUEST_CONTACT_RECOVERY:${reservationId}`;
}

export async function syncChannexGuestContactRecovery(
  prisma: PrismaClient,
  reservationId: string,
  incoming: {
    guestEmail?: string | null;
    guestPhone?: string | null;
  },
  dependencies: { upsert: typeof upsertOperationalIssue } = { upsert: upsertOperationalIssue }
) {
  const reservation = await prisma.reservation.findUnique({
    where: { id: reservationId },
    select: {
      id: true,
      reservationNumber: true,
      guestName: true,
      guestEmail: true,
      guestPhone: true,
      status: true,
      externalProvider: true,
      propertyId: true,
      property: { select: { organizationId: true } },
    },
  });

  if (!reservation || String(reservation.externalProvider ?? "").toUpperCase() !== "CHANNEX") {
    return { applicable: false as const };
  }

  const effectiveState = classifyGuestContact(reservation);
  const operationalKey = guestContactRecoveryOperationalKey(reservation.id);
  const existingIssue = await prisma.operationalIssue.findUnique({
    where: { operationalKey },
    select: { id: true, workflowState: true },
  });

  if (reservation.status === ReservationStatus.CANCELLED) {
    if (!existingIssue) return { applicable: true as const, state: effectiveState, cancelled: true as const };
    await dependencies.upsert(prisma, {
      operationalKey,
      issueCode: "GUEST_CONTACT_RECOVERY_CANCELLED",
      title: "Guest contact recovery closed",
      issue: "The reservation was cancelled, so guest contact recovery is no longer required.",
      operationalImpact: null,
      recommendedAction: null,
      nextAutomaticStep: null,
      engine: "GUEST_OPERATIONS",
      severity: "INFO",
      workflowState: "RESOLVED",
      visibility: "SYSTEM",
      responsibleActor: "NONE",
      actionRequired: false,
      canAutoResolve: true,
      autoResolveStatus: "SUCCEEDED",
      autoResolveActionCode: null,
      reservationId: reservation.id,
      reservationNumber: reservation.reservationNumber,
      propertyId: reservation.propertyId,
      organizationId: reservation.property.organizationId,
      guestName: reservation.guestName,
      sourceType: "ENGINE_EVENT",
      actionTarget: "GUEST",
      resolutionCode: "RESERVATION_CANCELLED",
      resolutionSummary: "Guest contact recovery closed because the reservation was cancelled.",
      resolutionType: "AUTOMATIC",
      resolvedBy: "PIN_GO",
      transitionCode: "GUEST_CONTACT_RECOVERY_CANCELLED",
      transitionSummary: "Pin&Go closed guest contact recovery after reservation cancellation.",
      transitionedBy: "PIN_GO",
      metadata: { effectiveState },
    });
    return { applicable: true as const, state: effectiveState, cancelled: true as const };
  }

  if (effectiveState === "COMPLETE") {
    if (!existingIssue) return { applicable: true as const, state: effectiveState };
    await dependencies.upsert(prisma, {
      operationalKey,
      issueCode: "GUEST_CONTACT_COMPLETE",
      title: "Guest contact information complete",
      issue: "Pin&Go has a guest email address and phone number for this Channex reservation.",
      operationalImpact: null,
      recommendedAction: null,
      nextAutomaticStep: null,
      engine: "GUEST_OPERATIONS",
      severity: "INFO",
      workflowState: "RESOLVED",
      visibility: "SYSTEM",
      responsibleActor: "NONE",
      actionRequired: false,
      canAutoResolve: true,
      autoResolveStatus: "SUCCEEDED",
      autoResolveActionCode: null,
      reservationId: reservation.id,
      reservationNumber: reservation.reservationNumber,
      propertyId: reservation.propertyId,
      organizationId: reservation.property.organizationId,
      guestName: reservation.guestName,
      sourceType: "ENGINE_EVENT",
      actionTarget: "GUEST",
      resolutionCode: "GUEST_CONTACT_AVAILABLE",
      resolutionSummary: "The Channex reservation now has complete guest contact information.",
      resolutionType: "AUTOMATIC",
      resolvedBy: "PIN_GO",
      transitionCode: "GUEST_CONTACT_RECOVERY_RESOLVED",
      transitionSummary: "Pin&Go detected complete guest contact information.",
      transitionedBy: "PIN_GO",
      metadata: {
        effectiveState,
        incomingEmailPresent: present(incoming.guestEmail),
        incomingPhonePresent: present(incoming.guestPhone),
        effectiveEmailPresent: true,
        effectivePhonePresent: true,
        source: "CHANNEX",
      },
    });
    return { applicable: true as const, state: effectiveState };
  }

  const missingFields =
    effectiveState === "BOTH_MISSING"
      ? ["EMAIL", "PHONE"]
      : effectiveState === "EMAIL_MISSING"
        ? ["EMAIL"]
        : ["PHONE"];

  await dependencies.upsert(prisma, {
    operationalKey,
    issueCode: "OTA_GUEST_CONTACT_MISSING",
    title: "Guest contact information required",
    issue: "This Channex reservation arrived without complete guest contact information.",
    operationalImpact: "Pin&Go cannot fully automate guest communications until a valid destination is available.",
    recommendedAction: `Add the missing guest ${missingFields.join(" and ").toLowerCase()} from the OTA reservation.`,
    nextAutomaticStep: null,
    engine: "GUEST_OPERATIONS",
    severity: "WARNING",
    workflowState: "ACTION_REQUIRED",
    visibility: "HOST",
    responsibleActor: "HOST",
    actionRequired: true,
    canAutoResolve: true,
    autoResolveStatus: "AVAILABLE",
    autoResolveActionCode: null,
    reservationId: reservation.id,
    reservationNumber: reservation.reservationNumber,
    propertyId: reservation.propertyId,
    organizationId: reservation.property.organizationId,
    guestName: reservation.guestName,
    sourceType: "ENGINE_EVENT",
    actionTarget: "GUEST",
    resolutionCode: null,
    resolutionSummary: null,
    resolutionType: null,
    resolvedBy: null,
    transitionCode: existingIssue ? "GUEST_CONTACT_RECOVERY_STILL_REQUIRED" : "GUEST_CONTACT_RECOVERY_REQUIRED",
    transitionSummary: `Guest contact recovery requires host action for: ${missingFields.join(", ")}.`,
    transitionedBy: "PIN_GO",
    metadata: {
      contactState: effectiveState,
      missingFields,
      incomingEmailPresent: present(incoming.guestEmail),
      incomingPhonePresent: present(incoming.guestPhone),
      effectiveEmailPresent: present(reservation.guestEmail),
      effectivePhonePresent: present(reservation.guestPhone),
      source: "CHANNEX",
    },
  });

  return { applicable: true as const, state: effectiveState, missingFields };
}
