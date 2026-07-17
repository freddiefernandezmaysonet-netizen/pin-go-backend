import {
  NfcAssignmentRole,
  NfcAssignmentStatus,
  PrismaClient,
  ReservationStatus,
  StaffAccessMethod,
  StaffAssignmentStatus,
} from "@prisma/client";
import { persistAuditEntry } from "../apms/audit-persistence.service";
import type { AuditEntry } from "../apms/audit-types";

export type CleanerAccessAutopilotTrigger =
  | "CLEANER_CONFIRMATION"
  | "RESERVATION_COMPLETE_FLOW_AUDIT"
  | "MANUAL_REPAIR";

export type CleanerAccessAutopilotResult = {
  ok: boolean;
  alreadyReady: boolean;
  repaired: boolean;
  skipped: boolean;
  escalated: boolean;
  reason: string;
  nfcAssignmentId?: string | null;
  error?: string | null;
};

function toErrString(error: unknown) {
  const anyError = error as any;

  if (error instanceof Error) {
    const code = anyError?.code ? ` code=${anyError.code}` : "";
    const status = anyError?.status ? ` status=${anyError.status}` : "";

    return `${error.name}: ${error.message}${code}${status}`;
  }

  return String(error);
}

function buildCancelledReservationSkipResult(): CleanerAccessAutopilotResult {
  return {
    ok: true,
    alreadyReady: false,
    repaired: false,
    skipped: true,
    escalated: false,
    reason:
      "RESERVATION_CANCELLED_CLEANER_ACCESS_SKIPPED",
    error: null,
  };
}

function computeCleaningWindowFromProperty(params: {
  checkOut: Date;
  cleaningStartOffsetMinutes?: number | null;
  cleaningDurationMinutes?: number | null;
}) {
  const offsetMinutes = params.cleaningStartOffsetMinutes ?? 30;
  const durationMinutes = params.cleaningDurationMinutes ?? 180;

  const startsAt = new Date(params.checkOut.getTime() + offsetMinutes * 60_000);
  const endsAt = new Date(startsAt.getTime() + durationMinutes * 60_000);

  return { startsAt, endsAt };
}

function buildDecisionId(params: {
  propertyId: string;
  reservationId: string;
  trigger: CleanerAccessAutopilotTrigger;
}) {
  return `access-engine:${params.propertyId}:${params.reservationId}:cleaner-nfc-autopilot:${params.trigger}`;
}

async function persistCleanerAccessAuditEntry(input: {
  prisma: PrismaClient;
  organizationId?: string | null;
  propertyId: string;
  reservationId: string;
  confirmationId?: string | null;
  staffMemberId?: string | null;
  nfcAssignmentId?: string | null;
  nfcCardId?: string | null;
  trigger: CleanerAccessAutopilotTrigger;
  status: AuditEntry["status"];
  severity: AuditEntry["severity"];
  eventType: AuditEntry["eventType"];
  reason: string;
  summary: string;
  recommendedAction?: string;
  error?: string | null;
}) {
  const now = new Date();

  const auditEntry: AuditEntry = {
    engine: "Access",
    decisionId: buildDecisionId({
      propertyId: input.propertyId,
      reservationId: input.reservationId,
      trigger: input.trigger,
    }),
    entityType: "ACCESS",
    entityId: input.nfcAssignmentId ?? input.confirmationId ?? input.reservationId,
    eventType: input.eventType,
    status: input.status,
    severity: input.severity,
    summary: input.summary,
    startedAt: now,
    completedAt: now,
    durationMs: 0,
    reason: input.reason,
    decisions: [
      {
        engine: "Access",
        rule:
          input.status === "SUCCESS"
            ? "CLEANER_NFC_ACCESS_ENSURED"
            : "CLEANER_NFC_ACCESS_NEEDS_ATTENTION",
        label:
          input.status === "SUCCESS"
            ? "Cleaner NFC Access Ensured"
            : "Cleaner NFC Access Needs Attention",
        applied: input.status === "SUCCESS",
        adjustment: null,
        adjustmentPercent: null,
        confidence: input.status === "SUCCESS" ? 100 : 0,
        metadata: {
          organizationId: input.organizationId ?? null,
          propertyId: input.propertyId,
          reservationId: input.reservationId,
          confirmationId: input.confirmationId ?? null,
          staffMemberId: input.staffMemberId ?? null,
          nfcAssignmentId: input.nfcAssignmentId ?? null,
          nfcCardId: input.nfcCardId ?? null,
          trigger: input.trigger,
          reason: input.reason,
          error: input.error ?? null,
        },
      },
    ],
    recommendedAction: input.recommendedAction,
    metadata: {
      organizationId: input.organizationId ?? null,
      propertyId: input.propertyId,
      reservationId: input.reservationId,
      confirmationId: input.confirmationId ?? null,
      staffMemberId: input.staffMemberId ?? null,
      nfcAssignmentId: input.nfcAssignmentId ?? null,
      nfcCardId: input.nfcCardId ?? null,
      trigger: input.trigger,
      reason: input.reason,
      error: input.error ?? null,
      accessMethod: "NFC_TIMEBOUND",
      accessRole: "CLEANING",
    },
  };

  try {
    await persistAuditEntry(input.prisma, auditEntry);
  } catch (auditError: any) {
    console.error("[CLEANER_ACCESS_AUTOPILOT_AUDIT_ERROR]", {
      propertyId: input.propertyId,
      reservationId: input.reservationId,
      confirmationId: input.confirmationId ?? null,
      reason: input.reason,
      error: auditError?.message ?? auditError,
    });
  }
}

async function markStaffAssignmentFailed(input: {
  prisma: PrismaClient;
  reservationId: string;
  staffMemberId: string;
  startsAt: Date;
  endsAt: Date;
  error: string;
}) {
  try {
    await input.prisma.staffAssignment.upsert({
      where: {
        reservationId_staffMemberId: {
          reservationId: input.reservationId,
          staffMemberId: input.staffMemberId,
        },
      },
      create: {
        reservationId: input.reservationId,
        staffMemberId: input.staffMemberId,
        method: StaffAccessMethod.NFC_TIMEBOUND,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        status: StaffAssignmentStatus.FAILED,
        lastError: input.error,
        retryCount: 1,
      },
      update: {
        method: StaffAccessMethod.NFC_TIMEBOUND,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        status: StaffAssignmentStatus.FAILED,
        lastError: input.error,
        retryCount: {
          increment: 1,
        },
      },
    });
  } catch (assignmentError: any) {
    console.error("[CLEANER_ACCESS_AUTOPILOT_ASSIGNMENT_FAILED_UPDATE_ERROR]", {
      reservationId: input.reservationId,
      staffMemberId: input.staffMemberId,
      error: assignmentError?.message ?? assignmentError,
    });
  }
}

async function markStaffAssignmentScheduled(input: {
  prisma: PrismaClient;
  reservationId: string;
  staffMemberId: string;
  startsAt: Date;
  endsAt: Date;
}) {
  await input.prisma.staffAssignment.upsert({
    where: {
      reservationId_staffMemberId: {
        reservationId: input.reservationId,
        staffMemberId: input.staffMemberId,
      },
    },
    create: {
      reservationId: input.reservationId,
      staffMemberId: input.staffMemberId,
      method: StaffAccessMethod.NFC_TIMEBOUND,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      status: StaffAssignmentStatus.SCHEDULED,
      lastError: null,
    },
    update: {
      method: StaffAccessMethod.NFC_TIMEBOUND,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      status: StaffAssignmentStatus.SCHEDULED,
      lastError: null,
    },
  });
}

async function failWithEscalation(input: {
  prisma: PrismaClient;
  organizationId?: string | null;
  propertyId: string;
  reservationId: string;
  confirmationId?: string | null;
  staffMemberId?: string | null;
  startsAt?: Date | null;
  endsAt?: Date | null;
  trigger: CleanerAccessAutopilotTrigger;
  reason: string;
  error: string;
  recommendedAction: string;
}): Promise<CleanerAccessAutopilotResult> {
  if (input.staffMemberId && input.startsAt && input.endsAt) {
    await markStaffAssignmentFailed({
      prisma: input.prisma,
      reservationId: input.reservationId,
      staffMemberId: input.staffMemberId,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      error: input.error,
    });
  }

  await persistCleanerAccessAuditEntry({
    prisma: input.prisma,
    organizationId: input.organizationId ?? null,
    propertyId: input.propertyId,
    reservationId: input.reservationId,
    confirmationId: input.confirmationId ?? null,
    staffMemberId: input.staffMemberId ?? null,
    trigger: input.trigger,
    status: "FAILED",
    severity: "CRITICAL",
    eventType: "ACTION_FAILED",
    reason: input.reason,
    summary:
      "Access Autopilot could not ensure cleaner NFC access after the cleaner confirmed availability.",
    recommendedAction: input.recommendedAction,
    error: input.error,
  });

  return {
    ok: false,
    alreadyReady: false,
    repaired: false,
    skipped: false,
    escalated: true,
    reason: input.reason,
    error: input.error,
  };
}

export async function ensureCleanerNfcAccessForConfirmedCleaning(input: {
  prisma: PrismaClient;
  reservationId: string;
  confirmationId?: string | null;
  trigger?: CleanerAccessAutopilotTrigger;
}): Promise<CleanerAccessAutopilotResult> {
  const trigger = input.trigger ?? "MANUAL_REPAIR";

  const confirmation = input.confirmationId
    ? await input.prisma.cleaningConfirmation.findUnique({
        where: {
          id: input.confirmationId,
        },
      })
    : await input.prisma.cleaningConfirmation.findFirst({
        where: {
          reservationId: input.reservationId,
          status: "CONFIRMED",
        },
        orderBy: {
          updatedAt: "desc",
        },
      });

  if (!confirmation) {
    return {
      ok: false,
      alreadyReady: false,
      repaired: false,
      skipped: true,
      escalated: false,
      reason: "CONFIRMED_CLEANING_CONFIRMATION_NOT_FOUND",
      error: "No confirmed cleaning confirmation was found for this reservation.",
    };
  }

  if (confirmation.status !== "CONFIRMED") {
    return {
      ok: true,
      alreadyReady: false,
      repaired: false,
      skipped: true,
      escalated: false,
      reason: "CLEANING_CONFIRMATION_NOT_CONFIRMED",
      error: null,
    };
  }

  const reservation = await input.prisma.reservation.findUnique({
    where: {
      id: confirmation.reservationId,
    },
    include: {
      property: {
        include: {
          locks: true,
        },
      },
    },
  });

  if (!reservation?.property) {
    return failWithEscalation({
      prisma: input.prisma,
      propertyId: confirmation.propertyId,
      reservationId: confirmation.reservationId,
      confirmationId: confirmation.id,
      staffMemberId: confirmation.staffMemberId,
      trigger,
      reason: "RESERVATION_OR_PROPERTY_NOT_FOUND",
      error: "Reservation or property was not found.",
      recommendedAction:
        "Review the reservation and property setup before cleaner arrival.",
    });
  }

   if (
    reservation.status ===
    ReservationStatus.CANCELLED
  ) {
    console.log(
      "[CLEANER_ACCESS_AUTOPILOT] skipped cancelled reservation",
      {
        reservationId: reservation.id,
        propertyId: reservation.propertyId,
        confirmationId: confirmation.id,
        staffMemberId: confirmation.staffMemberId,
        trigger,
      }
    );

    return buildCancelledReservationSkipResult();
  }

  if (!reservation.property.cleaningNfcEnabled) {
    console.log(
      "[CLEANER_ACCESS_AUTOPILOT] skipped because cleaning NFC is disabled",
      {
        reservationId: reservation.id,
        propertyId: reservation.propertyId,
        confirmationId: confirmation.id,
        staffMemberId: confirmation.staffMemberId,
        trigger,
      }
    );

    return {
      ok: true,
      alreadyReady: false,
      repaired: false,
      skipped: true,
      escalated: false,
      reason: "CLEANER_NFC_DISABLED_FOR_PROPERTY",
      error: null,
    };
  }

  const staffMember = await input.prisma.staffMember.findUnique({
    where: {
      id: confirmation.staffMemberId,
    },
  });

  const { startsAt, endsAt } = computeCleaningWindowFromProperty({
    checkOut: reservation.checkOut,
    cleaningStartOffsetMinutes: reservation.property.cleaningStartOffsetMinutes,
    cleaningDurationMinutes: reservation.property.cleaningDurationMinutes,
  });

  if (!staffMember) {
    return failWithEscalation({
      prisma: input.prisma,
      organizationId: reservation.property.organizationId,
      propertyId: confirmation.propertyId,
      reservationId: confirmation.reservationId,
      confirmationId: confirmation.id,
      staffMemberId: confirmation.staffMemberId,
      startsAt,
      endsAt,
      trigger,
      reason: "CLEANER_NOT_FOUND",
      error: "Cleaner staff member was not found.",
      recommendedAction:
        "Assign a valid cleaner and ensure cleaning NFC access before the cleaning window.",
    });
  }

  await markStaffAssignmentScheduled({
    prisma: input.prisma,
    reservationId: confirmation.reservationId,
    staffMemberId: confirmation.staffMemberId,
    startsAt,
    endsAt,
  });

 const existingCleaningNfc = await input.prisma.nfcAssignment.findFirst({
  where: {
    reservationId: confirmation.reservationId,
    role: NfcAssignmentRole.CLEANING,
    status: {
      in: [
        NfcAssignmentStatus.SCHEDULED,
        NfcAssignmentStatus.PROVISIONING,
        NfcAssignmentStatus.ACTIVE,
      ],
    },
  },
  orderBy: {
    createdAt: "desc",
  },
});


  const lock = reservation.property.locks.find(
    (item) => item.isActive && item.ttlockLockId
  );

if (existingCleaningNfc) {
  const alreadyActive =
    existingCleaningNfc.status === NfcAssignmentStatus.ACTIVE;

  const existingReason = alreadyActive
    ? "CLEANER_NFC_ACCESS_ALREADY_ACTIVE"
    : "CLEANER_NFC_ACCESS_ALREADY_SCHEDULED";

  await persistCleanerAccessAuditEntry({
    prisma: input.prisma,
    organizationId: reservation.property.organizationId,
    propertyId: confirmation.propertyId,
    reservationId: confirmation.reservationId,
    confirmationId: confirmation.id,
    staffMemberId: confirmation.staffMemberId,
    nfcAssignmentId: existingCleaningNfc.id,
    nfcCardId: existingCleaningNfc.nfcCardId,
    trigger,
    status: "SUCCESS",
    severity: "INFO",
    eventType: "DECISION_APPLIED",
    reason: existingReason,
    summary: alreadyActive
      ? "Access Autopilot verified existing active cleaner NFC access for the confirmed cleaning assignment."
      : "Access Autopilot verified that cleaner NFC access is scheduled for provisioning before the cleaning window.",
  });

  return {
    ok: true,
    alreadyReady: true,
    repaired: false,
    skipped: false,
    escalated: false,
    reason: existingReason,
    nfcAssignmentId: existingCleaningNfc.id,
    error: null,
  };
}

  const ttlockLockId = lock?.ttlockLockId ? Number(lock.ttlockLockId) : null;

  if (!ttlockLockId) {
    return failWithEscalation({
      prisma: input.prisma,
      organizationId: reservation.property.organizationId,
      propertyId: confirmation.propertyId,
      reservationId: confirmation.reservationId,
      confirmationId: confirmation.id,
      staffMemberId: confirmation.staffMemberId,
      startsAt,
      endsAt,
      trigger,
      reason: "ACTIVE_LOCK_MISSING_FOR_CLEANER_ACCESS",
      error: "No active TTLock lock is configured for this property.",
      recommendedAction:
        "Assign an active TTLock lock to this property and rerun cleaner access repair.",
    });
  }

  const staffCardRef = String(staffMember.ttlockCardRef ?? "").trim();

  if (!staffCardRef) {
    return failWithEscalation({
      prisma: input.prisma,
      organizationId: reservation.property.organizationId,
      propertyId: confirmation.propertyId,
      reservationId: confirmation.reservationId,
      confirmationId: confirmation.id,
      staffMemberId: confirmation.staffMemberId,
      startsAt,
      endsAt,
      trigger,
      reason: "CLEANER_TTLOCK_CARD_REF_MISSING",
      error: `Staff member ${staffMember.id} is missing ttlockCardRef.`,
      recommendedAction:
        "Assign a TTLock/NFC card reference to this cleaner and rerun cleaner access repair.",
    });
  }

  const staffCard = await input.prisma.nfcCard.findFirst({
    where: {
      propertyId: confirmation.propertyId,
      label: staffCardRef,
    },
  });

  if (!staffCard) {
    return failWithEscalation({
      prisma: input.prisma,
      organizationId: reservation.property.organizationId,
      propertyId: confirmation.propertyId,
      reservationId: confirmation.reservationId,
      confirmationId: confirmation.id,
      staffMemberId: confirmation.staffMemberId,
      startsAt,
      endsAt,
      trigger,
      reason: "CLEANER_NFC_CARD_NOT_FOUND",
      error: `NFC card not found for label=${staffCardRef}.`,
      recommendedAction:
        "Create or map the cleaner NFC card in Pin&Go and rerun cleaner access repair.",
    });
  }

  const overlappingAssignment = await input.prisma.nfcAssignment.findFirst({
    where: {
      nfcCardId: staffCard.id,
      status: {
  in: [
    NfcAssignmentStatus.SCHEDULED,
    NfcAssignmentStatus.PROVISIONING,
    NfcAssignmentStatus.ACTIVE,
  ],
},
      reservationId: {
        not: confirmation.reservationId,
      },
      startsAt: {
        lt: endsAt,
      },
      endsAt: {
        gt: startsAt,
      },
    },
    orderBy: {
      createdAt: "desc",
    },
  });

  if (overlappingAssignment) {
    return failWithEscalation({
      prisma: input.prisma,
      organizationId: reservation.property.organizationId,
      propertyId: confirmation.propertyId,
      reservationId: confirmation.reservationId,
      confirmationId: confirmation.id,
      staffMemberId: confirmation.staffMemberId,
      startsAt,
      endsAt,
      trigger,
      reason: "CLEANER_NFC_CARD_ALREADY_ASSIGNED_FOR_WINDOW",
      error: `NFC card ${staffCard.id} already has an overlapping active assignment.`,
      recommendedAction:
        "Assign a different cleaner NFC card or review overlapping cleaner access before the cleaning window.",
    });
  }

  const latestReservationState =
  await input.prisma.reservation.findUnique({
    where: {
      id: confirmation.reservationId,
    },
    select: {
      status: true,
    },
  });

if (
  latestReservationState?.status ===
  ReservationStatus.CANCELLED
) {
  console.log(
    "[CLEANER_ACCESS_AUTOPILOT] skipped reservation cancelled before scheduling",
    {
      reservationId: confirmation.reservationId,
      propertyId: confirmation.propertyId,
      confirmationId: confirmation.id,
      staffMemberId: confirmation.staffMemberId,
      trigger,
    }
  );

  return buildCancelledReservationSkipResult();
}

try {
  const nfcAssignment =
    await input.prisma.nfcAssignment.create({
      data: {
        reservationId: confirmation.reservationId,
        nfcCardId: staffCard.id,
        role: NfcAssignmentRole.CLEANING,
        status: NfcAssignmentStatus.SCHEDULED,
        startsAt,
        endsAt,
        lastError: null,
        retryCount: 0,
        provisioningStartedAt: null,
        provisionedAt: null,
      },
    });

  await markStaffAssignmentScheduled({
    prisma: input.prisma,
    reservationId: confirmation.reservationId,
    staffMemberId: confirmation.staffMemberId,
    startsAt,
    endsAt,
  });

  await persistCleanerAccessAuditEntry({
    prisma: input.prisma,
    organizationId: reservation.property.organizationId,
    propertyId: confirmation.propertyId,
    reservationId: confirmation.reservationId,
    confirmationId: confirmation.id,
    staffMemberId: confirmation.staffMemberId,
    nfcAssignmentId: nfcAssignment.id,
    nfcCardId: staffCard.id,
    trigger,
    status: "SUCCESS",
    severity: "INFO",
    eventType: "DECISION_APPLIED",
    reason: "CLEANER_NFC_ACCESS_SCHEDULED",
    summary:
      "Access Autopilot scheduled cleaner NFC access for provisioning two hours before the cleaning window.",
  });

  console.log(
    "[CLEANER_ACCESS_AUTOPILOT] cleaner NFC access scheduled",
    {
      reservationId: confirmation.reservationId,
      propertyId: confirmation.propertyId,
      confirmationId: confirmation.id,
      staffMemberId: confirmation.staffMemberId,
      nfcAssignmentId: nfcAssignment.id,
      nfcCardId: staffCard.id,
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(),
      trigger,
    }
  );

  return {
    ok: true,
    alreadyReady: false,
    repaired: true,
    skipped: false,
    escalated: false,
    reason: "CLEANER_NFC_ACCESS_SCHEDULED",
    nfcAssignmentId: nfcAssignment.id,
    error: null,
  };
} catch (error) {
  const errorMessage = toErrString(error);

  return failWithEscalation({
    prisma: input.prisma,
    organizationId: reservation.property.organizationId,
    propertyId: confirmation.propertyId,
    reservationId: confirmation.reservationId,
    confirmationId: confirmation.id,
    staffMemberId: confirmation.staffMemberId,
    startsAt,
    endsAt,
    trigger,
    reason: "CLEANER_NFC_ACCESS_SCHEDULING_FAILED",
    error: errorMessage,
    recommendedAction:
      "Review the cleaner card mapping and schedule cleaner NFC access before the cleaning window.",
  });
 }
}