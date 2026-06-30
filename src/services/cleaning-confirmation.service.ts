import { PrismaClient } from "@prisma/client";
import crypto from "crypto";
import { persistAuditEntry } from "../apms/audit-persistence.service";
import type { AuditEntry } from "../apms/audit-types";

const prisma = new PrismaClient();

function buildCleaningMessagingDecisionId(params: {
  propertyId: string;
  reservationId: string;
}) {
  return `messaging-engine:${params.propertyId}:${params.reservationId}:cleaning-confirmation`;
}

async function persistCleaningMessagingAuditEntry(input: {
  reservationId: string;
  propertyId: string;
  staffMemberId: string;
  confirmationId?: string | null;
  status: AuditEntry["status"];
  severity: AuditEntry["severity"];
  eventType: AuditEntry["eventType"];
  reason: string;
  summary: string;
  decisions: AuditEntry["decisions"];
  recommendedAction?: string;
}) {
  const now = new Date();

  const auditEntry: AuditEntry = {
    engine: "Messaging",
    decisionId: buildCleaningMessagingDecisionId({
      propertyId: input.propertyId,
      reservationId: input.reservationId,
    }),
    entityType: "MESSAGING",
    entityId: input.confirmationId ?? input.reservationId,
    eventType: input.eventType,
    status: input.status,
    severity: input.severity,
    summary: input.summary,
    startedAt: now,
    completedAt: now,
    durationMs: 0,
    reason: input.reason,
    decisions: input.decisions,
    recommendedAction: input.recommendedAction,
    metadata: {
      propertyId: input.propertyId,
      reservationId: input.reservationId,
      staffMemberId: input.staffMemberId,
      confirmationId: input.confirmationId ?? null,
      notificationType: "CLEANING_CONFIRMATION",
      intendedChannel: "SMS_LINK",
    },
  };

  try {
    await persistAuditEntry(prisma, auditEntry);
  } catch (auditPersistenceError: any) {
    console.error("[APMS_MESSAGING_AUDIT_PERSIST_ERROR]", {
      engine: "Messaging",
      propertyId: input.propertyId,
      reservationId: input.reservationId,
      staffMemberId: input.staffMemberId,
      confirmationId: input.confirmationId ?? null,
      error:
        auditPersistenceError?.message ??
        auditPersistenceError,
    });
  }
}

export async function createCleaningConfirmation(params: {
  reservationId: string;
  propertyId: string;
  staffMemberId: string;
}) {
  const { reservationId, propertyId, staffMemberId } = params;

  const staff = await prisma.staffMember.findUnique({
    where: { id: staffMemberId },
  });

  if (!staff || !staff.phoneE164) {
    console.warn("[CLEANING_CONFIRMATION] skipped: staff missing phone", {
      reservationId,
      propertyId,
      staffMemberId,
    });

    await persistCleaningMessagingAuditEntry({
      reservationId,
      propertyId,
      staffMemberId,
      status: "SKIPPED",
      severity: "WARNING",
      eventType: "DECISION_SKIPPED",
      reason: "CLEANER_PHONE_MISSING",
      summary:
        "Messaging Engine could not prepare cleaning confirmation because the assigned cleaner is missing a phone number.",
      decisions: [
        {
          engine: "Messaging",
          rule: "CLEANER_PHONE_REQUIRED",
          label: "Cleaner Phone Required",
          applied: false,
          adjustment: null,
          adjustmentPercent: null,
          confidence: 100,
          metadata: {
            propertyId,
            reservationId,
            staffMemberId,
            hasStaffPhone: false,
          },
        },
      ],
      recommendedAction:
        "Add a phone number to the assigned cleaner before sending cleaning confirmations.",
    });

    return null;
  }
  const reservation = await prisma.reservation.findUnique({
    where: { id: reservationId },
    include: {
      property: true,
    },
  });

    if (!reservation) {
    console.warn("[CLEANING_CONFIRMATION] skipped: reservation not found", {
      reservationId,
      propertyId,
      staffMemberId,
    });

    await persistCleaningMessagingAuditEntry({
      reservationId,
      propertyId,
      staffMemberId,
      status: "FAILED",
      severity: "WARNING",
      eventType: "ACTION_FAILED",
      reason: "RESERVATION_NOT_FOUND",
      summary:
        "Messaging Engine could not prepare cleaning confirmation because the reservation was not found.",
      decisions: [
        {
          engine: "Messaging",
          rule: "RESERVATION_FOUND",
          label: "Reservation Found",
          applied: false,
          adjustment: null,
          adjustmentPercent: null,
          confidence: 100,
          metadata: {
            propertyId,
            reservationId,
            staffMemberId,
          },
        },
      ],
      recommendedAction:
        "Review the reservation before preparing cleaner notifications.",
    });

    return null;
  }
  const existing = await prisma.cleaningConfirmation.findFirst({
    where: {
      reservationId,
      propertyId,
      staffMemberId,
      status: "PENDING",
    },
    orderBy: {
      createdAt: "desc",
    },
  });

   if (existing) {
    console.log("[CLEANING_CONFIRMATION] pending already exists", {
      reservationId,
      propertyId,
      staffMemberId,
      confirmationId: existing.id,
    });

    await persistCleaningMessagingAuditEntry({
      reservationId,
      propertyId,
      staffMemberId,
      confirmationId: existing.id,
      status: "SUCCESS",
      severity: "INFO",
      eventType: "DECISION_APPLIED",
      reason: "CLEANING_CONFIRMATION_PENDING_EXISTS",
      summary:
        "Messaging Engine reused an existing pending cleaning confirmation for the cleaner.",
      decisions: [
        {
          engine: "Messaging",
          rule: "CLEANER_PHONE_AVAILABLE",
          label: "Cleaner Phone Available",
          applied: true,
          adjustment: null,
          adjustmentPercent: null,
          confidence: 100,
          metadata: {
            propertyId,
            reservationId,
            staffMemberId,
            hasStaffPhone: true,
          },
        },
        {
          engine: "Messaging",
          rule: "CLEANING_CONFIRMATION_PENDING_EXISTS",
          label: "Cleaning Confirmation Pending Exists",
          applied: true,
          adjustment: null,
          adjustmentPercent: null,
          confidence: 100,
          metadata: {
            propertyId,
            reservationId,
            staffMemberId,
            confirmationId: existing.id,
          },
        },
      ],
    });

    return existing;
  }
  const token = crypto.randomBytes(32).toString("hex");

  const confirmation = await prisma.cleaningConfirmation.create({
    data: {
      reservationId,
      propertyId,
      staffMemberId,
      token,
      status: "PENDING",
    },
  });
  console.log("[CLEANING_CONFIRMATION] created pending", {
    reservationId,
    propertyId,
    staffMemberId,
    confirmationId: confirmation.id,
    timezone: reservation.property?.timezone ?? null,
  });

  return confirmation;
 
}