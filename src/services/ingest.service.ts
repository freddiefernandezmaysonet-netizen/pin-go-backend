import {
  PrismaClient,
  PaymentState,
  AccessGrantType,
  AccessStatus,
  AccessMethod,
  StaffAccessMethod,
  StaffAssignmentStatus,
  ReservationStatus,
  GuestAccessMode,
} from "@prisma/client";

import crypto from "crypto";
import { computeCleaningWindowPR } from "../services/cleaningWindow.service";
import { reconcileReservation } from "./reservation.reconcile.service";
import { log } from "../utils/log";
import { fromZonedTime } from "date-fns-tz";
import { selectNextStaffForProperty } from "./staff-selection.service";
import { createCleaningConfirmation } from "./cleaning-confirmation.service";
import { generateReservationNumber } from "./reservation-number.service";
import { createReservationAuditEntry } from "../apms/reservation-audit.mapper";
import { persistAuditEntry } from "../apms/audit-persistence.service";
import type { AuditEntry } from "../apms/audit-types";
import { ensureReservationGuestAgreementSnapshot } from "./guest-agreement.service";

console.log("[INGEST] running src/services/ingest.service.ts", new Date().toISOString());
const prisma = new PrismaClient();

export type IngestPayload = {
  source?: string;

  propertyId: string;
  guestName: string;
  guestEmail?: string | null;
  guestPhone?: string | null;
  roomName?: string | null;

  checkIn: string;
  checkOut: string;
  paymentState?: "NONE" | "PAID" | "FAILED" | "PENDING";

  externalProvider?: string | null;
  externalId?: string | null;
  externalUpdatedAt?: string | null;
  externalRaw?: any | null;
  status?: "ACTIVE" | "CANCELLED";
};

type IngestReservationResult = {
  reservationId: string;
  reservationNumber: string | null;
  guestToken: string | null;
  accessGrantId?: string | null;
  lockId?: string | null;
  warning?: string;
  didChange: boolean;
  cleaningConfirmation?: {
    reservationId: string;
    propertyId: string;
    staffMemberId: string;
  } | null;
};

function norm(s?: string | null) {
  return (s ?? "").trim().toLowerCase();
}

function buildIngestKey(p: {
  source?: string;
  propertyId: string;
  guestName: string;
  guestEmail?: string | null;
  guestPhone?: string | null;
  roomName?: string | null;
  checkIn?: Date | string;
  checkOut?: Date | string;
  externalProvider?: string | null;
  externalId?: string | null;
}) {
  const externalProvider = norm(p.externalProvider);
  const externalId = norm(p.externalId);

  if (externalProvider && externalId) {
    return crypto
      .createHash("sha1")
      .update(
        [
          norm(p.source ?? "unknown"),
          p.propertyId,
          externalProvider,
          externalId,
        ].join("|")
      )
      .digest("hex");
  }

  const raw = [
    norm(p.source ?? "unknown"),
    p.propertyId,
    norm(p.guestEmail),
    norm(p.guestPhone),
    norm(p.roomName),
    norm(p.guestName),
    p.checkIn instanceof Date ? p.checkIn.toISOString() : norm(String(p.checkIn ?? "")),
    p.checkOut instanceof Date ? p.checkOut.toISOString() : norm(String(p.checkOut ?? "")),
  ].join("|");

  return crypto.createHash("sha1").update(raw).digest("hex");
}

function makeToken(bytes = 16) {
  return crypto.randomBytes(bytes).toString("hex");
}

function isDateOnly(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value.trim());
}

function buildLocalDateFromDateOnly(
  value: string,
  time: string,
  timezone: string
) {
  const [hours, minutes] = time.split(":").map(Number);

  const localDateTime = new Date(
    `${value.trim()}T${String(hours ?? 0).padStart(2, "0")}:${String(
      minutes ?? 0
    ).padStart(2, "0")}:00`
  );

  return fromZonedTime(localDateTime, timezone);
}

export async function ingestReservation(p: IngestPayload) {
  const property = await prisma.property.findUnique({
    where: { id: p.propertyId },
    select: {
      checkInTime: true,
      timezone: true,
      guestAccessMode: true,
    },
  });

  const propertyCheckInTime = property?.checkInTime ?? "15:00";
  const propertyCheckOutTime = "11:00";
  const propertyTimeZone = property?.timezone ?? "America/Puerto_Rico";

  const checkIn =
    typeof p.checkIn === "string"
      ? isDateOnly(p.checkIn)
        ? buildLocalDateFromDateOnly(p.checkIn, propertyCheckInTime, propertyTimeZone)
        : new Date(p.checkIn)
      : new Date(p.checkIn);

  const checkOut =
    typeof p.checkOut === "string"
      ? isDateOnly(p.checkOut)
        ? buildLocalDateFromDateOnly(p.checkOut, propertyCheckOutTime, propertyTimeZone)
        : new Date(p.checkOut)
      : new Date(p.checkOut);

  if (isNaN(checkIn.getTime())) throw new Error("Invalid checkIn");
  if (isNaN(checkOut.getTime())) throw new Error("Invalid checkOut");
  if (checkOut <= checkIn) throw new Error("checkOut must be after checkIn");

  let paymentState: PaymentState;

  if (p.paymentState && p.paymentState !== "NONE") {
    paymentState = p.paymentState as PaymentState;
  } else {
    const raw = p.externalRaw ?? p;
    const amountPaid = Number((raw as any).amount_paid ?? 0);

    const hasSuccessfulTransaction =
      Array.isArray((raw as any).transactions) &&
      (raw as any).transactions.some(
        (t: any) => String(t?.status ?? "").toLowerCase() === "done"
      );

    if (amountPaid > 0 || hasSuccessfulTransaction) {
      paymentState = PaymentState.PAID;
    } else {
      paymentState = PaymentState.NONE;
    }
  }

  const guestTokenExpiresAt = new Date(checkOut.getTime() + 48 * 60 * 60 * 1000);
  const externalProvider = (p.externalProvider ?? "").trim() || null;
  const externalId = (p.externalId ?? "").trim() || null;

    const result: IngestReservationResult = await prisma.$transaction(async (tx) => {
    const { reservation, didChange } = await upsertReservation(tx as any, {
      source: p.source,

      propertyId: p.propertyId,
      guestAccessModeSnapshot:
      property?.guestAccessMode ??
      GuestAccessMode.PASSCODE_ONLY,
      guestName: p.guestName,
      guestEmail: p.guestEmail ?? null,
      guestPhone: p.guestPhone ?? null,
      roomName: p.roomName ?? null,

      checkIn,
      checkOut,
      paymentState,
      guestTokenExpiresAt,

      externalProvider,
      externalId,
      externalUpdatedAt: p.externalUpdatedAt ? new Date(p.externalUpdatedAt) : null,
      externalRaw: p.externalRaw ?? null,
      status: p.status ?? undefined,
    });

    const ensured = await ensureGuestToken(tx as any, reservation.id, guestTokenExpiresAt);

    const lock = await tx.lock.findFirst({
      where: { propertyId: reservation.propertyId, isActive: true },
      orderBy: { createdAt: "asc" },
    });

    if (!lock) {
     return {
  reservationId: reservation.id,
  reservationNumber: reservation.reservationNumber,
  guestToken: ensured.guestToken,
  warning: `No active lock found for property ${reservation.propertyId}. AccessGrant not created.`,
  didChange,
  cleaningConfirmation: null,
};
    }

console.log("[INGEST_LOCK]", {
  reservationId: reservation.id,
  propertyId: reservation.propertyId,
  foundLock: !!lock,
  lockId: lock?.id,
});

    const grant = await ensureGuestGrant(tx as any, {
      reservationId: reservation.id,
      lockId: lock.id,
      startsAt: reservation.checkIn,
      endsAt: reservation.checkOut,
    });

    let cleaningConfirmation: {
      reservationId: string;
      propertyId: string;
      staffMemberId: string;
    } | null = null;

  try {
  const staff = await selectNextStaffForProperty({
    propertyId: reservation.propertyId,
  });

  console.log("[CLEANING_STAFF_SELECTED]", {
    reservationId: reservation.id,
    propertyId: reservation.propertyId,
    staffId: staff?.id ?? null,
    staffPhone: staff?.phoneE164 ?? null,
  });

  if (staff) {
    cleaningConfirmation = {
      reservationId: reservation.id,
      propertyId: reservation.propertyId,
      staffMemberId: staff.id,
    };
  }
} catch (e) {
  console.error("[CLEANING_CONFIRMATION_SELECT_ERROR]", e);
}
    return {
  reservationId: reservation.id,
  reservationNumber: reservation.reservationNumber,
  guestToken: ensured.guestToken,
  accessGrantId: grant?.id ?? null,
  lockId: lock.id,
  didChange,
  cleaningConfirmation,
};
  });

console.log("[CLEANING_CONFIRMATION_RESULT]", {
  reservationId: result.reservationId,
  cleaningConfirmation: result.cleaningConfirmation,
});

let cleaningConfirmationCreated = false;

if (result.cleaningConfirmation) {
  await createCleaningConfirmation(result.cleaningConfirmation);
  cleaningConfirmationCreated = true;
}

const guestAgreementSnapshotResult =
  await ensureReservationGuestAgreementSnapshot(
    prisma,
    result.reservationId
  );

if (!guestAgreementSnapshotResult.ok) {
  console.warn("[GUEST_AGREEMENT_SNAPSHOT_MISSING]", {
    reservationId: result.reservationId,
    reservationNumber: result.reservationNumber,
    propertyId: p.propertyId,
    reason: guestAgreementSnapshotResult.reason,
  });
}

  if (result.didChange) {
    await reconcileReservation(result.reservationId);
  }
 
  const auditEntry = createReservationAuditEntry({
    reservationId: result.reservationId,
    propertyId: p.propertyId,
    reason: result.didChange ? "RESERVATION_CHANGED" : "RESERVATION_UNCHANGED",
    steps: [
      {
        rule: result.didChange
          ? "RESERVATION_UPSERTED"
          : "RESERVATION_UNCHANGED",
        label: result.didChange
          ? "Reservation Created or Updated"
          : "Reservation Already Current",
        applied: true,
        metadata: {
          reservationId: result.reservationId,
          source: p.source ?? null,
          externalProvider,
          externalId,
        },
      },
      {
        rule: "GUEST_TOKEN_ENSURED",
        label: "Guest Token Ensured",
        applied: Boolean(result.guestToken),
        metadata: {
          reservationId: result.reservationId,
          guestTokenExpiresAt,
        },
      },
      {
        rule: result.lockId ? "ACTIVE_LOCK_FOUND" : "ACTIVE_LOCK_MISSING",
        label: result.lockId ? "Active Lock Found" : "Active Lock Missing",
        applied: true,
        metadata: {
          propertyId: p.propertyId,
          lockId: result.lockId ?? null,
        },
      },
      {
        rule: result.accessGrantId
          ? "ACCESS_GRANT_ENSURED"
          : "ACCESS_GRANT_SKIPPED",
        label: result.accessGrantId
          ? "Guest Access Grant Ensured"
          : "Guest Access Grant Skipped",
        applied: Boolean(result.accessGrantId),
        metadata: {
          reservationId: result.reservationId,
          accessGrantId: result.accessGrantId ?? null,
        },
      },
      {
        rule: result.cleaningConfirmation
          ? "CLEANING_STAFF_SELECTED"
          : "CLEANING_STAFF_SKIPPED",
        label: result.cleaningConfirmation
          ? "Cleaning Staff Selected"
          : "Cleaning Staff Skipped",
        applied: Boolean(result.cleaningConfirmation),
        metadata: {
          reservationId: result.reservationId,
          propertyId: p.propertyId,
          staffMemberId: result.cleaningConfirmation?.staffMemberId ?? null,
        },
      },
      {
        rule: cleaningConfirmationCreated
          ? "CLEANING_CONFIRMATION_CREATED"
          : "CLEANING_CONFIRMATION_SKIPPED",
        label: cleaningConfirmationCreated
          ? "Cleaning Confirmation Created"
          : "Cleaning Confirmation Skipped",
        applied: cleaningConfirmationCreated,
        metadata: {
          reservationId: result.reservationId,
        },
      },
      {
        rule: result.didChange
          ? "RESERVATION_RECONCILED"
          : "RESERVATION_RECONCILE_SKIPPED",
        label: result.didChange
          ? "Reservation Reconciled"
          : "Reservation Reconcile Skipped",
        applied: result.didChange,
        metadata: {
          reservationId: result.reservationId,
        },
      },
    ],
   metadata: {
  source: p.source ?? null,
  externalProvider,
  externalId,
  paymentState,
  checkIn,
  checkOut,
  reservationNumber: result.reservationNumber,
  warning: result.warning ?? null,
},
  });

  try {
    await persistAuditEntry(prisma, auditEntry);
  } catch (auditPersistenceError: any) {
    console.error("[APMS_AUDIT_PERSIST_ERROR]", {
      engine: "Reservation",
      reservationId: result.reservationId,
      propertyId: p.propertyId,
      error:
        auditPersistenceError?.message ??
        auditPersistenceError,
    });
  }

  const accessAuditStatus: AuditEntry["status"] = result.accessGrantId
    ? "SUCCESS"
    : result.lockId
    ? "SKIPPED"
    : "FAILED";

  const accessAuditSeverity: AuditEntry["severity"] = result.accessGrantId
    ? "INFO"
    : "WARNING";

  const accessAuditEventType: AuditEntry["eventType"] = result.accessGrantId
    ? "DECISION_APPLIED"
    : result.lockId
    ? "DECISION_SKIPPED"
    : "ACTION_FAILED";

  const accessAuditEntry: AuditEntry = {
    engine: "Access",
    decisionId: `access-engine:${p.propertyId}:${result.reservationId}`,
    entityType: "ACCESS",
    entityId: result.accessGrantId ?? result.reservationId,
    eventType: accessAuditEventType,
    status: accessAuditStatus,
    severity: accessAuditSeverity,
    summary: result.accessGrantId
      ? "Access Engine ensured guest access for the reservation."
      : result.lockId
      ? "Access Engine found an active lock but did not create a guest access grant."
      : "Access Engine could not ensure guest access because no active lock was found.",
    startedAt: new Date(),
    completedAt: new Date(),
    durationMs: 0,
    reason: result.accessGrantId
      ? "ACCESS_GRANT_ENSURED"
      : result.lockId
      ? "ACCESS_GRANT_SKIPPED"
      : "ACTIVE_LOCK_MISSING",
    decisions: [
      {
        engine: "Access",
        rule: result.lockId ? "ACTIVE_LOCK_FOUND" : "ACTIVE_LOCK_MISSING",
        label: result.lockId ? "Active Lock Found" : "Active Lock Missing",
        applied: Boolean(result.lockId),
        adjustment: null,
        adjustmentPercent: null,
        confidence: 100,
        metadata: {
          propertyId: p.propertyId,
          lockId: result.lockId ?? null,
        },
      },
      {
        engine: "Access",
        rule: result.accessGrantId
          ? "ACCESS_GRANT_ENSURED"
          : "ACCESS_GRANT_MISSING",
        label: result.accessGrantId
          ? "Guest Access Grant Ensured"
          : "Guest Access Grant Missing",
        applied: Boolean(result.accessGrantId),
        adjustment: null,
        adjustmentPercent: null,
        confidence: 100,
        metadata: {
          reservationId: result.reservationId,
          accessGrantId: result.accessGrantId ?? null,
        },
      },
    ],
    recommendedAction: result.accessGrantId
      ? undefined
      : "Review lock assignment and guest access grant for this reservation.",
  metadata: {
  propertyId: p.propertyId,
  reservationId: result.reservationId,
  reservationNumber: result.reservationNumber,
  lockId: result.lockId ?? null,
  accessGrantId: result.accessGrantId ?? null,
  source: p.source ?? null,
  externalProvider,
  externalId,
},
  };

  try {
    await persistAuditEntry(prisma, accessAuditEntry);
  } catch (auditPersistenceError: any) {
    console.error("[APMS_ACCESS_AUDIT_PERSIST_ERROR]", {
      engine: "Access",
      reservationId: result.reservationId,
      propertyId: p.propertyId,
      accessGrantId: result.accessGrantId ?? null,
      lockId: result.lockId ?? null,
      error:
        auditPersistenceError?.message ??
        auditPersistenceError,
    });
  }

  const cleaningStaffSelected = Boolean(
    result.cleaningConfirmation?.staffMemberId
  );

  const cleaningAuditStatus: AuditEntry["status"] =
    cleaningConfirmationCreated ? "SUCCESS" : "SKIPPED";

  const cleaningAuditSeverity: AuditEntry["severity"] =
    cleaningConfirmationCreated ? "INFO" : "WARNING";

  const cleaningAuditEventType: AuditEntry["eventType"] =
    cleaningConfirmationCreated ? "ACTION_COMPLETED" : "DECISION_SKIPPED";

  const cleaningAuditEntry: AuditEntry = {
    engine: "Cleaning",
    decisionId: `cleaning-engine:${p.propertyId}:${result.reservationId}`,
    entityType: "CLEANING",
    entityId: result.reservationId,
    eventType: cleaningAuditEventType,
    status: cleaningAuditStatus,
    severity: cleaningAuditSeverity,
    summary: cleaningConfirmationCreated
      ? "Cleaning Engine prepared cleaning confirmation for the reservation."
      : cleaningStaffSelected
      ? "Cleaning Engine selected a cleaner but did not create a cleaning confirmation."
      : "Cleaning Engine could not prepare cleaning because no cleaner was assigned.",
    startedAt: new Date(),
    completedAt: new Date(),
    durationMs: 0,
    reason: cleaningConfirmationCreated
      ? "CLEANING_CONFIRMATION_CREATED"
      : cleaningStaffSelected
      ? "CLEANING_CONFIRMATION_SKIPPED"
      : "CLEANING_STAFF_MISSING",
    decisions: [
      {
        engine: "Cleaning",
        rule: cleaningStaffSelected
          ? "CLEANING_STAFF_SELECTED"
          : "CLEANING_STAFF_MISSING",
        label: cleaningStaffSelected
          ? "Cleaning Staff Selected"
          : "Cleaning Staff Missing",
        applied: cleaningStaffSelected,
        adjustment: null,
        adjustmentPercent: null,
        confidence: 100,
        metadata: {
          propertyId: p.propertyId,
          reservationId: result.reservationId,
          staffMemberId:
            result.cleaningConfirmation?.staffMemberId ?? null,
        },
      },
      {
        engine: "Cleaning",
        rule: cleaningConfirmationCreated
          ? "CLEANING_CONFIRMATION_CREATED"
          : "CLEANING_CONFIRMATION_MISSING",
        label: cleaningConfirmationCreated
          ? "Cleaning Confirmation Created"
          : "Cleaning Confirmation Missing",
        applied: cleaningConfirmationCreated,
        adjustment: null,
        adjustmentPercent: null,
        confidence: 100,
        metadata: {
          propertyId: p.propertyId,
          reservationId: result.reservationId,
          staffMemberId:
            result.cleaningConfirmation?.staffMemberId ?? null,
        },
      },
    ],
    recommendedAction: cleaningConfirmationCreated
      ? undefined
      : "Assign a cleaner and verify cleaning confirmation for this reservation.",
    metadata: {
  propertyId: p.propertyId,
  reservationId: result.reservationId,
  reservationNumber: result.reservationNumber,
  staffMemberId:
    result.cleaningConfirmation?.staffMemberId ?? null,
  source: p.source ?? null,
  externalProvider,
  externalId,
  checkIn,
  checkOut,
},
  };

  try {
    await persistAuditEntry(prisma, cleaningAuditEntry);
  } catch (auditPersistenceError: any) {
    console.error("[APMS_CLEANING_AUDIT_PERSIST_ERROR]", {
      engine: "Cleaning",
      reservationId: result.reservationId,
      propertyId: p.propertyId,
      staffMemberId:
        result.cleaningConfirmation?.staffMemberId ?? null,
      error:
        auditPersistenceError?.message ??
        auditPersistenceError,
    });
  }

  log("ingest.result", {
  reservationId: result.reservationId,
  reservationNumber: result.reservationNumber,
  didChange: result.didChange,
});
  return {
    ...result,
    auditEntry,
  };
}

async function upsertReservation(
  tx: PrismaClient,
  input: {
    source?: string;

    propertyId: string;
    
    guestName: string;
    guestEmail?: string | null;
    guestPhone?: string | null;
    roomName?: string | null;
    guestAccessModeSnapshot: GuestAccessMode;
    externalProvider?: string | null;
    externalId?: string | null;
    externalUpdatedAt?: Date | null;
    externalRaw?: any | null;
    status?: "ACTIVE" | "CANCELLED";

    checkIn: Date;
    checkOut: Date;
    paymentState: PaymentState;
    guestTokenExpiresAt: Date;
  }
): Promise<{ reservation: any; didChange: boolean }> {
 const ingestKey = buildIngestKey({
  source: input.source,
  propertyId: input.propertyId,
  guestName: input.guestName,
  guestEmail: input.guestEmail ?? null,
  guestPhone: input.guestPhone ?? null,
  roomName: input.roomName ?? null,
  checkIn: input.checkIn,
  checkOut: input.checkOut,
  externalProvider: input.externalProvider ?? null,
  externalId: input.externalId ?? null,
});
  
  const hasPmsKey = !!(input.externalProvider && input.externalId);

  if (hasPmsKey) {
    const existingByPms = await tx.reservation.findUnique({
      where: {
        propertyId_externalProvider_externalId: {
          propertyId: input.propertyId,
          externalProvider: input.externalProvider!,
          externalId: input.externalId!,
        },
      },
      select: { id: true, externalUpdatedAt: true },
    });

    function isOlderOrSame(incoming?: Date | null, current?: Date | null) {
      if (!incoming || !current) return false;
      return incoming.getTime() <= current.getTime();
    }

    if (existingByPms) {
      const existing = await tx.reservation.findUnique({
        where: { id: existingByPms.id },
        select: { paymentState: true },
      });

      const raw = input.externalRaw ?? {};
      const amountPaid = Number((raw as any).amount_paid ?? 0);

      const hasSuccessfulTransaction =
        Array.isArray((raw as any).transactions) &&
        (raw as any).transactions.some(
          (t: any) => String(t?.status ?? "").toLowerCase() === "done"
        );

      const recalculatedPaymentState =
        amountPaid > 0 || hasSuccessfulTransaction
          ? PaymentState.PAID
          : PaymentState.NONE;

      const paymentChanged = existing?.paymentState !== recalculatedPaymentState;

      if (
        !paymentChanged &&
        isOlderOrSame(
          input.externalUpdatedAt ?? null,
          existingByPms.externalUpdatedAt ?? null
        )
      ) {
        const reservation = await tx.reservation.findUnique({
          where: { id: existingByPms.id },
        });
        return { reservation, didChange: false };
      }
    }

    if (existingByPms) {
      const stayStarted = Date.now() >= input.checkIn.getTime();

      if (input.status === "CANCELLED" && stayStarted) {
        const reservation = await tx.reservation.update({
          where: { id: existingByPms.id },
          data: {
            externalUpdatedAt: input.externalUpdatedAt ?? undefined,
            externalRaw: input.externalRaw ?? undefined,
            lastIngestError: "CANCEL_REJECTED_ACTIVE_STAY",
            lastIngestedAt: new Date(),
          },
        });

        return { reservation, didChange: false };
      }

      const reservation = await tx.reservation.update({
        where: { id: existingByPms.id },
        data: {
          source: input.source ?? undefined,

          guestName: input.guestName,
          guestEmail: input.guestEmail ?? null,
          guestPhone: input.guestPhone ?? null,
          roomName: input.roomName ?? null,

          externalUpdatedAt: input.externalUpdatedAt ?? undefined,
          externalRaw: input.externalRaw ?? undefined,
          status: input.status
            ? input.status === "CANCELLED"
              ? ReservationStatus.CANCELLED
              : ReservationStatus.ACTIVE
            : undefined,

          checkIn: input.checkIn,
          checkOut: input.checkOut,
          paymentState: input.paymentState,
          guestTokenExpiresAt: input.guestTokenExpiresAt,

          lastIngestError: null,
          lastIngestedAt: new Date(),
        },
      });

      return { reservation, didChange: true };
    }

    const existingByIngestKey = await tx.reservation.findUnique({
      where: { ingestKey },
      select: { id: true },
    });

    if (existingByIngestKey) {
      const reservation = await tx.reservation.update({
        where: { id: existingByIngestKey.id },
        data: {
          externalProvider: input.externalProvider!,
          externalId: input.externalId!,

          source: input.source ?? undefined,
          guestName: input.guestName,
          guestEmail: input.guestEmail ?? null,
          guestPhone: input.guestPhone ?? null,
          roomName: input.roomName ?? null,

          externalUpdatedAt: input.externalUpdatedAt ?? undefined,
          externalRaw: input.externalRaw ?? undefined,
          status: input.status
            ? input.status === "CANCELLED"
              ? ReservationStatus.CANCELLED
              : ReservationStatus.ACTIVE
            : undefined,

          checkIn: input.checkIn,
          checkOut: input.checkOut,
          paymentState: input.paymentState,
          guestTokenExpiresAt: input.guestTokenExpiresAt,

          lastIngestError: null,
          lastIngestedAt: new Date(),
        },
      });

      return { reservation, didChange: true };
    }

    const reservationNumber = await generateReservationNumber(tx);

    const reservation = await tx.reservation.create({
      data: {
        reservationNumber,
        ingestKey,
        source: input.source ?? null,

        propertyId: input.propertyId,
        guestAccessModeSnapshot:
          input.guestAccessModeSnapshot,
        guestName: input.guestName,
        guestEmail: input.guestEmail ?? null,
        guestPhone: input.guestPhone ?? null,
        roomName: input.roomName ?? null,

        externalProvider: input.externalProvider!,
        externalId: input.externalId!,
        externalUpdatedAt: input.externalUpdatedAt ?? null,
        externalRaw: input.externalRaw ?? undefined,
        status:
          input.status === "CANCELLED"
            ? ReservationStatus.CANCELLED
            : ReservationStatus.ACTIVE,

        checkIn: input.checkIn,
        checkOut: input.checkOut,
        paymentState: input.paymentState,
        guestTokenExpiresAt: input.guestTokenExpiresAt,

        lastIngestError: null,
        lastIngestedAt: new Date(),
      },
    });

    return { reservation, didChange: true };
  }

  const reservationNumber = await generateReservationNumber(tx);

  const reservation = await tx.reservation.upsert({
    where: { ingestKey },
    create: {
      reservationNumber,
      ingestKey,
      source: input.source ?? null,

      propertyId: input.propertyId,
      guestAccessModeSnapshot:
        input.guestAccessModeSnapshot,
      guestName: input.guestName,
      guestEmail: input.guestEmail ?? null,
      guestPhone: input.guestPhone ?? null,
      roomName: input.roomName ?? null,

      externalProvider: input.externalProvider ?? null,
      externalId: input.externalId ?? null,
      externalUpdatedAt: input.externalUpdatedAt ?? null,
      externalRaw: input.externalRaw ?? undefined,
      status:
        input.status === "CANCELLED"
          ? ReservationStatus.CANCELLED
          : ReservationStatus.ACTIVE,

      checkIn: input.checkIn,
      checkOut: input.checkOut,
      paymentState: input.paymentState,
      guestTokenExpiresAt: input.guestTokenExpiresAt,

      lastIngestError: null,
      lastIngestedAt: new Date(),
    },
    update: {
      source: input.source ?? undefined,

      guestName: input.guestName,
      guestEmail: input.guestEmail ?? null,
      guestPhone: input.guestPhone ?? null,
      roomName: input.roomName ?? null,

      externalUpdatedAt: input.externalUpdatedAt ?? undefined,
      externalRaw: input.externalRaw ?? undefined,
      status: input.status
        ? input.status === "CANCELLED"
          ? ReservationStatus.CANCELLED
          : ReservationStatus.ACTIVE
        : undefined,

      checkIn: input.checkIn,
      checkOut: input.checkOut,
      paymentState: input.paymentState,
      guestTokenExpiresAt: input.guestTokenExpiresAt,

      lastIngestError: null,
      lastIngestedAt: new Date(),
    },
  });

  return { reservation, didChange: true };
}

async function ensureGuestToken(
  tx: PrismaClient,
  reservationId: string,
  expiresAt: Date
) {
  const r = await tx.reservation.findUnique({
    where: { id: reservationId },
    select: { guestToken: true },
  });

  if (!r) throw new Error("Reservation not found");

  if (r.guestToken) {
    await tx.reservation.update({
      where: { id: reservationId },
      data: { guestTokenExpiresAt: expiresAt },
    });
    return { guestToken: r.guestToken };
  }

  const token = makeToken(16);
  const updated = await tx.reservation.update({
    where: { id: reservationId },
    data: { guestToken: token, guestTokenExpiresAt: expiresAt },
    select: { guestToken: true },
  });

  return { guestToken: updated.guestToken! };
}

async function ensureGuestGrant(
  tx: PrismaClient,
  input: { reservationId: string; lockId: string; startsAt: Date; endsAt: Date }
) {
  const existing = await tx.accessGrant.findFirst({
    where: {
      reservationId: input.reservationId,
      lockId: input.lockId,
      type: AccessGrantType.GUEST,
    },
    orderBy: { createdAt: "desc" },
  });

  if (!existing) {
    return tx.accessGrant.create({
      data: {
        reservationId: input.reservationId,
        lockId: input.lockId,
        type: AccessGrantType.GUEST,
        method: AccessMethod.PASSCODE_TIMEBOUND,
        status: AccessStatus.PENDING,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
      },
    });
  }

  if (existing.status !== AccessStatus.PENDING) return existing;

  return tx.accessGrant.update({
    where: { id: existing.id },
    data: {
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      method: AccessMethod.PASSCODE_TIMEBOUND,
    },
  });
}