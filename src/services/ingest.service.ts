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

console.log("[INGEST] running src/services/ingest.service.ts", new Date().toISOString());
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

// 🔥 FIX: aplicar hora de propiedad cuando Lodgify no envía hora

const rawCheckIn = new Date(p.checkIn);
const rawCheckOut = new Date(p.checkOut);

// obtener property (debe ya existir en tu flujo)
const property = await prisma.property.findUnique({
  where: { id: p.propertyId },
  select: {
    checkInTime: true,
    timezone: true,
  },
});

// defaults
const checkInTime = property?.checkInTime ?? "15:00";
const checkOutTime = property?.checkOutTime ?? "11:00";

// helper simple
function applyTime(date: Date, time: string) {
  const [h, m] = time.split(":").map(Number);
  const d = new Date(date);
  d.setHours(h, m, 0, 0);
  return d;
}

const checkIn = applyTime(rawCheckIn, checkInTime);
const checkOut = applyTime(rawCheckOut, checkOutTime);
  
  if (isNaN(checkIn.getTime())) throw new Error("Invalid checkIn");
  if (isNaN(checkOut.getTime())) throw new Error("Invalid checkOut");
  if (checkOut <= checkIn) throw new Error("checkOut must be after checkIn");

  const paymentState: PaymentState =
    (p.paymentState as PaymentState) ?? PaymentState.NONE;

  const guestTokenExpiresAt = new Date(checkOut.getTime() + 48 * 60 * 60 * 1000);
  const externalProvider = (p.externalProvider ?? "").trim() || null;
  const externalId = (p.externalId ?? "").trim() || null;

  // ✅ 1) termina la transacción y guarda el resultado
  const result = await prisma.$transaction(async (tx) => {
    // 1) Upsert Reservation por ingestKey
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
              status: reservationStatus,
            },
            update: {
              method: StaffAccessMethod.NFC_TIMEBOUND,
              startsAt,
              endsAt,
              status: input.status ? reservationStatus : undefined,            
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

 // ✅ 2) AHORA sí: fuera del tx (evita TTLock dentro de la transacción)
  
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

  
  // ✅ PMS KEY path (out-of-order protected)
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
    // ✅ viejo o repetido → ignorar
    if (
      existingByPms &&
      isOlderOrSame(input.externalUpdatedAt ?? null, existingByPms.externalUpdatedAt ?? null)
    ) {
      const reservation = await tx.reservation.findUnique({ where: { id: existingByPms.id } });
      return { reservation, didChange: false };
    }

   // ✅ existe por PMS → update
if (existingByPms) {

  // ✅ Regla enterprise: NO permitir CANCELLED si ya empezó la estancia
  const stayStarted = Date.now() >= input.checkIn.getTime();

  if (input.status === "CANCELLED" && stayStarted) {
    // No cambiamos status; solo registramos el evento PMS para auditoría
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
        ? (input.status === "CANCELLED"
            ? ReservationStatus.CANCELLED
            : ReservationStatus.ACTIVE)
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
    // ✅ no existe por PMS → intenta adoptar legacy por ingestKey
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
            ? (input.status === "CANCELLED"
                ? ReservationStatus.CANCELLED
                : ReservationStatus.ACTIVE)
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

    // ✅ create nuevo con PMS key + ingestKey
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
    // ✅ fallback legacy: NO PMS key → upsert por ingestKey
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
        ? (input.status === "CANCELLED"
            ? ReservationStatus.CANCELLED
            : ReservationStatus.ACTIVE)
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
        method: AccessMethod.PASSCODE_TIMEBOUND, // tu enum actual
        status: AccessStatus.PENDING,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
      },
    });
  }

  // si ya está ACTIVE/REVOKED/etc, no lo tocamos aquí
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