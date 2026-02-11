import {
  PrismaClient,
  PaymentState,
  AccessGrantType,
  AccessStatus,
  AccessMethod,
  StaffAccessMethod,
  StaffAssignmentStatus,
} from "@prisma/client";

import crypto from "crypto";
import { computeCleaningWindowPR } from "../services/cleaningWindow.service";

const prisma = new PrismaClient();

export type IngestPayload = {
  source?: string;

  propertyId: string;
  guestName: string;
  guestEmail?: string | null;
  guestPhone?: string | null;
  roomName?: string | null;

  checkIn: string; // ISO string
  checkOut: string; // ISO string
  paymentState?: "NONE" | "PAID" | "FAILED" | "PENDING";
};

function norm(s?: string | null) {
  return (s ?? "").trim().toLowerCase();
}

/**
 * Idempotencia interna (cuando no tienes externalReservationId).
 * OJO: incluye email/phone. Si cambian, cambia la key.
 * Si quieres key más estable, te lo ajusto.
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

  return crypto.createHash("sha1").update(raw).digest("hex"); // 40 chars
}

function makeToken(bytes = 16) {
  return crypto.randomBytes(bytes).toString("hex");
}

export async function ingestReservation(p: IngestPayload) {
  const checkIn = new Date(p.checkIn);
  const checkOut = new Date(p.checkOut);

  if (isNaN(checkIn.getTime())) throw new Error("Invalid checkIn");
  if (isNaN(checkOut.getTime())) throw new Error("Invalid checkOut");
  if (checkOut <= checkIn) throw new Error("checkOut must be after checkIn");

  const paymentState: PaymentState =
    (p.paymentState as PaymentState) ?? PaymentState.NONE;

  const guestTokenExpiresAt = new Date(checkOut.getTime() + 48 * 60 * 60 * 1000);

  return prisma.$transaction(async (tx) => {
    // 1) Upsert Reservation por ingestKey
    const reservation = await upsertReservation(tx, {
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
    });

    // 2) Asegurar guestToken
    const ensured = await ensureGuestToken(tx, reservation.id, guestTokenExpiresAt);

    // 3) Lock activa
    const lock = await tx.lock.findFirst({
      where: { propertyId: reservation.propertyId, isActive: true },
      orderBy: { createdAt: "asc" },
    });

    if (!lock) {
      return {
        reservationId: reservation.id,
        guestToken: ensured.guestToken,
        warning: `No active lock found for property ${reservation.propertyId}. AccessGrant not created.`,
      };
    }

    // 4) Grant GUEST PENDING
    const grant = await ensureGuestGrant(tx, {
      reservationId: reservation.id,
      lockId: lock.id,
      startsAt: reservation.checkIn,
      endsAt: reservation.checkOut,
    });

// 5) StaffAssignment limpieza (PR 11:30 → 16:00) - NO rompe ingest si falla
try {
  // 5.1 Buscar orgId desde la Property
  const prop = await tx.property.findUnique({
    where: { id: reservation.propertyId },
    select: { organizationId: true },
  });

  const organizationId = prop?.organizationId;
  if (organizationId) {
    // 5.2 Buscar 1 staff activo (MVP: el primero)
    const staff = await tx.staffMember.findFirst({
      where: { organizationId, isActive: true },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });

    if (staff) {
      // 5.3 Calcular ventana 11:30 → 16:00 (PR)
      const { startsAt, endsAt } = computeCleaningWindowPR(reservation.checkOut);

      // 5.4 Upsert idempotente (requiere @@unique([reservationId, staffMemberId]))
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
  // safe: no rompe ingest
}
  
  return {
      reservationId: reservation.id,
      guestToken: ensured.guestToken,
      accessGrantId: grant?.id ?? null,
      lockId: lock.id,
    };
  });
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

    checkIn: Date;
    checkOut: Date;
    paymentState: PaymentState;
    guestTokenExpiresAt: Date;
  }
) {
  const ingestKey = buildIngestKey({
    source: input.source,
    propertyId: input.propertyId,
    guestName: input.guestName,
    guestEmail: input.guestEmail ?? null,
    guestPhone: input.guestPhone ?? null,
    roomName: input.roomName ?? null,
  });

  return tx.reservation.upsert({
    where: { ingestKey },
    create: {
      ingestKey,
      source: input.source ?? null,

      propertyId: input.propertyId,
      guestName: input.guestName,
      guestEmail: input.guestEmail ?? null,
      guestPhone: input.guestPhone ?? null,
      roomName: input.roomName ?? null,

      checkIn: input.checkIn,
      checkOut: input.checkOut,
      paymentState: input.paymentState,
      guestTokenExpiresAt: input.guestTokenExpiresAt,
    },
    update: {
      source: input.source ?? undefined,

      guestName: input.guestName,
      guestEmail: input.guestEmail ?? null,
      guestPhone: input.guestPhone ?? null,
      roomName: input.roomName ?? null,

      checkIn: input.checkIn,
      checkOut: input.checkOut,
      paymentState: input.paymentState,
      guestTokenExpiresAt: input.guestTokenExpiresAt,
    },
  });
}

async function ensureGuestToken(tx: PrismaClient, reservationId: string, expiresAt: Date) {
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

  if (existing.status !== AccessStatus.PENDING) {
    return existing;
  }

  return tx.accessGrant.update({
    where: { id: existing.id },
    data: {
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      method: AccessMethod.PASSCODE_TIMEBOUND,
    },
  });
}
