import crypto from "node:crypto";
import { AccessGrantType, PrismaClient } from "@prisma/client";
import { persistAuditEntry } from "../apms/audit-persistence.service";
import { syncChannexGuestContactRecovery } from "./ota-guest-contact-recovery.service";
import { materializeGuestAccessCommunicationOutbox } from "./guest-journey-access-communications-outbox.service";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^\+[1-9]\d{7,14}$/;

function clean(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

export class GuestContactRecoveryError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode: number
  ) {
    super(message);
    this.name = "GuestContactRecoveryError";
  }
}

export async function recoverChannexGuestContactByHost(input: {
  prisma?: PrismaClient;
  organizationId: string;
  reservationId: string;
  requestedByUserId: string;
  guestEmail?: unknown;
  guestPhone?: unknown;
}) {
  const prisma = input.prisma ?? new PrismaClient();
  const organizationId = clean(input.organizationId);
  const reservationId = clean(input.reservationId);
  const requestedByUserId = clean(input.requestedByUserId);
  if (!organizationId || !reservationId || !requestedByUserId) {
    throw new GuestContactRecoveryError("INVALID_SCOPE", "Authenticated organization, reservation and user are required.", 400);
  }

  const reservation = await prisma.reservation.findFirst({
    where: { id: reservationId, property: { organizationId } },
    select: {
      id: true, reservationNumber: true, propertyId: true, externalProvider: true,
      guestEmail: true, guestPhone: true,
    },
  });
  if (!reservation) throw new GuestContactRecoveryError("RESERVATION_NOT_FOUND", "Reservation not found.", 404);
  if (String(reservation.externalProvider ?? "").toUpperCase() !== "CHANNEX") {
    throw new GuestContactRecoveryError("NOT_CHANNEX_RESERVATION", "Guest contact recovery is only available for Channex reservations.", 409);
  }

  const hasEmail = Object.prototype.hasOwnProperty.call(input, "guestEmail");
  const hasPhone = Object.prototype.hasOwnProperty.call(input, "guestPhone");
  if (!hasEmail && !hasPhone) {
    throw new GuestContactRecoveryError("CONTACT_UPDATE_REQUIRED", "Provide at least one guest contact field.", 400);
  }

  const email = hasEmail ? clean(input.guestEmail) : "";
  const phone = hasPhone ? clean(input.guestPhone) : "";
  if (hasEmail && !email) throw new GuestContactRecoveryError("EMAIL_CANNOT_BE_CLEARED", "Existing guest email cannot be cleared.", 400);
  if (hasPhone && !phone) throw new GuestContactRecoveryError("PHONE_CANNOT_BE_CLEARED", "Existing guest phone cannot be cleared.", 400);
  if (hasEmail && !EMAIL_RE.test(email)) throw new GuestContactRecoveryError("INVALID_GUEST_EMAIL", "Guest email is invalid.", 400);
  if (hasPhone && !PHONE_RE.test(phone)) throw new GuestContactRecoveryError("INVALID_GUEST_PHONE", "Guest phone must use E.164 format.", 400);

  const updated = await prisma.reservation.update({
    where: { id: reservation.id },
    data: {
      ...(hasEmail ? { guestEmail: email } : {}),
      ...(hasPhone ? { guestPhone: phone } : {}),
    },
    select: { id: true, guestEmail: true, guestPhone: true },
  });

  const now = new Date();
  await persistAuditEntry(prisma, {
    engine: "Guest Operations",
    decisionId: `guest-contact-recovery:host:${reservation.id}:${crypto.randomUUID()}`,
    entityType: "RESERVATION",
    entityId: reservation.id,
    eventType: "GUEST_CONTACT_RECOVERED_BY_HOST",
    status: "SUCCESS",
    severity: "INFO",
    summary: "An authenticated host supplied missing guest contact information for a Channex reservation.",
    reason: "HOST_RECOVERY",
    decisions: {
      emailUpdated: hasEmail,
      phoneUpdated: hasPhone,
      provenance: "HOST_RECOVERY",
    },
    metadata: {
      organizationId,
      propertyId: reservation.propertyId,
      reservationId: reservation.id,
      reservationNumber: reservation.reservationNumber,
      requestedByUserId,
      provenance: "HOST_RECOVERY",
    },
    startedAt: now,
    completedAt: now,
    durationMs: 0,
  });

  await syncChannexGuestContactRecovery(prisma, reservation.id, {
    guestEmail: null,
    guestPhone: null,
  });

  let communications = {
    status: "NOT_ELIGIBLE_YET" as "MATERIALIZED" | "NOT_ELIGIBLE_YET",
    created: 0,
    deduplicated: 0,
  };
  const grants = await prisma.accessGrant.findMany({
    where: { reservationId: reservation.id, type: AccessGrantType.GUEST },
    select: { id: true },
  });
  if (grants.length > 0) {
    try {
      const outbox = await materializeGuestAccessCommunicationOutbox(prisma, {
        organizationId,
        propertyId: reservation.propertyId,
        reservationId: reservation.id,
        accessGrantIds: grants.map((grant) => grant.id),
      });
      communications = {
        status: "MATERIALIZED",
        created: outbox.created,
        deduplicated: outbox.deduplicated,
      };
    } catch (error: any) {
      const code = String(error?.message ?? "");
      const expectedNotReady =
        code === "ACCESS_COMMUNICATIONS_OUTBOX_RELEASE_EVIDENCE_MISSING" ||
        code === "ACCESS_COMMUNICATIONS_OUTBOX_CANONICAL_GRANT_MISSING_OR_AMBIGUOUS";
      if (!expectedNotReady) throw error;
    }
  }

  return {
    ok: true as const,
    reservationId: reservation.id,
    guestEmail: updated.guestEmail,
    guestPhone: updated.guestPhone,
    communications,
  };
}
