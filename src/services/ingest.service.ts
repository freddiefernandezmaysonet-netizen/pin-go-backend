import {
  PrismaClient,
  PaymentState,
  AccessGrantType,
  AccessStatus,
  AccessMethod,
  StaffAccessMethod,
  StaffAssignmentStatus,
  ReservationStatus,
} from "@prisma/client";

import crypto from "crypto";
import { computeCleaningWindowPR } from "../services/cleaningWindow.service";
import { reconcileReservation } from "./reservation.reconcile.service";
import { log } from "../utils/log";
import { fromZonedTime } from "date-fns-tz";

console.log("[INGEST] running src/services/ingest.service.ts", new Date().toISOString());
const prisma = new PrismaClient();

export type IngestPayload = {
  source?: string;

  propertyId: string;
  guestName: string;
  guestEmail?: string | null;
  guestPhone?: string | null;
  roomName?: string | null;

  checkIn: string; // ISO string o YYYY-MM-DD
  checkOut: string; // ISO string o YYYY-MM-DD
  paymentState?: "NONE" | "PAID" | "FAILED" | "PENDING";

  // ✅ PMS identity + ordering + status
  externalProvider?: string | null;
  externalId?: string | null;
  externalUpdatedAt?: string | null;
  externalRaw?: any | null;
  status?: "ACTIVE" | "CANCELLED";
};

function norm(s?: string | null) {
  return (s ?? "").trim().toLowerCase();
}

/**
 * Idempotencia interna (cuando no tienes externalReservationId).
 * OJO: incluye email/phone. Si cambian, cambia la key.
 */
function buildIngestKey(p: {
  source?: string;
  propertyId: string;
  guestName: string;
  guestEmail?: string | null;
  guestPhone?: string | null;
  roomName?: string | null;
}) {
  const raw = [
    norm(p.source ?? "unknown"),
    p.propertyId,
    norm(p.guestEmail),
    norm(p.guestPhone),
    norm(p.roomName),
    norm(p.guestName),
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

if (p.paymentState) {
  paymentState = p.paymentState as PaymentState;
} else {
  const amountPaid = Number((p as any).amount_paid ?? 0);

  const hasSuccessfulTransaction =
    Array.isArray((p as any).transactions) &&
    (p as any).transactions.some(
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

  const result = await prisma.$transaction(async (tx) => {
    const { reservation, didChange } = await upsertReservation(tx, {
      source: p.source,

      propertyId: p.propertyId,
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

    const ensured = await ensureGuestToken(tx, reservation.id, guestTokenExpiresAt);

    const lock = await tx.lock.findFirst({
      where: { propertyId: reservation.propertyId, isActive: true },
      orderBy: { createdAt: "asc" },
    });

    if (!lock) {
      return {
        reservationId: reservation.id,
        guestToken: ensured.guestToken,
        warning: `No active lock found for property ${reservation.propertyId}. AccessGrant not created.`,
        didChange,
      };
    }

    const grant = await ensureGuestGrant(tx, {
      reservationId: reservation.id,
      lockId: lock.id,
      startsAt: reservation.checkIn,
      endsAt: reservation.checkOut,
    });

    try {
      const prop = await tx.property.findUnique({
        where: { id: reservation.propertyId },
        select: { organizationId: true },
      });

      const organizationId = prop?.organizationId;
      if (organizationId) {
        const staff = await tx.staffMember.findFirst({
          where: { organizationId, isActive: true },
          orderBy: { createdAt: "asc" },
          select: { id: true },
        });

        if (staff) {
          const { startsAt, endsAt } = computeCleaningWindowPR(reservation.checkOut);

          await tx.staffAssignment.upsert({
            where: {
              reservationId_staffMemberId: {
                reservationId: reservation.id,
                staffMemberId: staff.id,
              },
            },
            create: {
              reservationId: reservation.id,
              staffMemberId: staff.id,
              method: StaffAccessMethod.NFC_TIMEBOUND,
              startsAt,
              endsAt,
              status: StaffAssignmentStatus.SCHEDULED,
            },
            update: {
              method: StaffAccessMethod.NFC_TIMEBOUND,
              startsAt,
              endsAt,
              status: StaffAssignmentStatus.SCHEDULED,
              lastError: null,
            },
          });
        }
      }
    } catch {
      // safe
    }

    return {
      reservationId: reservation.id,
      guestToken: ensured.guestToken,
      accessGrantId: grant?.id ?? null,
      lockId: lock.id,
      didChange,
    };
  });

  if (result.didChange) {
    await reconcileReservation(result.reservationId);
  }

  log("ingest.result", {
    reservationId: result.reservationId,
    didChange: result.didChange,
  });

  return result;
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

    if (
      existingByPms &&
      isOlderOrSame(input.externalUpdatedAt ?? null, existingByPms.externalUpdatedAt ?? null)
    ) {
      const reservation = await tx.reservation.findUnique({
        where: { id: existingByPms.id },
      });
      return { reservation, didChange: false };
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

    const reservation = await tx.reservation.create({
      data: {
        ingestKey,
        source: input.source ?? null,

        propertyId: input.propertyId,
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

  const reservation = await tx.reservation.upsert({
    where: { ingestKey },
    create: {
      ingestKey,
      source: input.source ?? null,

      propertyId: input.propertyId,
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