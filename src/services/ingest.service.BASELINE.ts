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

 // ✅ PMS identity + ordering + status
  externalProvider?: string | null;        // "cloudbeds" | "guesty" | etc
  externalId?: string | null;              // id de reserva en el PMS
  externalUpdatedAt?: string | null;       // ISO string (para out-of-order)
  externalRaw?: any | null;                // payload/snapshot opcional
  status?: "ACTIVE" | "CANCELLED";         // cancelación PMS
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

  // ✅ 1) termina la transacción y guarda el resultado
  const result = await prisma.$transaction(async (tx) => {
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
   
      externalProvider: p.externalProvider ?? null,
      externalId: p.externalId ?? null,
      externalUpdatedAt: p.externalUpdatedAt ? new Date(p.externalUpdatedAt) : null,
      externalRaw: p.externalRaw ?? null,
      status: p.status ?? undefined,
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

    // 5) StaffAssignment limpieza (safe)
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
    };
  });

  // ✅ 2) AHORA sí: fuera del tx (evita TTLock dentro de la transacción)
  await reconcileReservation(result.reservationId);

  return result;
}