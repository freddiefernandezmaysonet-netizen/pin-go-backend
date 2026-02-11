// src/services/nfc.service.ts
import { Prisma } from "@prisma/client";
import { ttlockChangeCardPeriod } from "../ttlock/ttlock.card";
import { ttlockListCards } from "../ttlock/ttlock.card";
type AssignParams = {
  reservationId: string;
  ttlockLockId: number;
  propertyId: string;
  role: Prisma.NfcAssignmentRole; // "GUEST" | "CLEANING"
  startsAt: Date;
  endsAt: Date;
  count: number; // cantidad de tarjetas a asignar
};

function isRetryableTtlockError(e: any) {
  const msg = String(e?.message ?? e).toLowerCase();
  return (
    msg.includes("timeout") ||
    msg.includes("timed out") ||
    msg.includes("econnreset") ||
    msg.includes("socket hang up") ||
    msg.includes("enotfound") ||
    msg.includes("eai_again") ||
    msg.includes("gateway") ||
    msg.includes("offline") ||
    msg.includes("sync")
  );
}

function isCardMissingError(e: any) {
  const msg = String(e?.message ?? e).toLowerCase();
  return (
    msg.includes("ic card does not exist") ||
    msg.includes("card does not exist")
  );
}


/**
 * Asigna N tarjetas del pool (AVAILABLE) a una reserva y activa vigencia en TTLock (changePeriod).
 * - Reusable: NO enroll aquí, solo changePeriod.
 */

// Clasifica por nombre en TTLock
function classifyCardName(name?: string): "GUEST" | "CLEANING" | "UNKNOWN" {
  const n = (name ?? "").trim().toLowerCase();
  if (!n) return "UNKNOWN";

  if (n.startsWith("cleaning service-")) return "CLEANING";
  if (n.startsWith("guest-")) return "GUEST";

  return "UNKNOWN";
}

export async function refreshNfcPoolFromTTLock(prisma: PrismaClient, params: {
  propertyId: string;
  ttlockLockId: number;
  minTotals?: { guest: number; cleaning: number };
}) {
  const minTotals = params.minTotals ?? { guest: 4, cleaning: 2 };

  // 1) Leer lista actual desde TTLock
  const resp = await ttlockListCards({
    lockId: Number(params.ttlockLockId),
    pageNo: 1,
    pageSize: 100,
  });

  const list: any[] = Array.isArray(resp?.list) ? resp.list : [];

  // 2) Validar mínimos en TTLock (por nombres)
  let guestTotal = 0;
  let cleaningTotal = 0;

  const ttlockCardIds: number[] = [];

  for (const item of list) {
    const cardId = Number(item?.cardId);
    if (!cardId) continue;
    ttlockCardIds.push(cardId);

    const kind = classifyCardName(item?.cardName);
    if (kind === "GUEST") guestTotal++;
    if (kind === "CLEANING") cleaningTotal++;
  }

  if (guestTotal < minTotals.guest || cleaningTotal < minTotals.cleaning) {
    throw new Error(
      `TTLock pool below minimum. Guest=${guestTotal}/${minTotals.guest}, Cleaning=${cleaningTotal}/${minTotals.cleaning}. ` +
      `Please enroll/rename cards in TTLock (e.g. Guest-1..Guest-4, Cleaning Service-1..2) and ensure gateway sync.`
    );
  }

  // 3) Upsert en Prisma (agrega nuevas / actualiza label)
  // Prisma compound unique generado normalmente: propertyId_ttlockCardId
  // Si tu nombre difiere, te digo cómo ajustarlo.
  const upserted: number[] = [];
  for (const item of list) {
    const cardId = Number(item?.cardId);
    if (!cardId) continue;

    const label = item?.cardName ? String(item.cardName) : `TTLock Card ${cardId}`;

    try {
      await prisma.nfcCard.upsert({
        where: {
          propertyId_ttlockCardId: {
            propertyId: String(params.propertyId),
            ttlockCardId: cardId,
          },
        },
        create: {
          propertyId: String(params.propertyId),
          ttlockCardId: cardId,
          label,
          status: NfcCardStatus.AVAILABLE,
        },
        update: {
          label,
          // No cambiamos status aquí porque puede estar ASSIGNED por una reserva activa
        },
      });

      upserted.push(cardId);
    } catch (e: any) {
      // si tu compound unique no se llama propertyId_ttlockCardId, verás error aquí.
      // En ese caso ajustamos el "where" al nombre correcto.
      throw new Error(`NfcCard upsert failed for cardId=${cardId}: ${String(e?.message ?? e)}`);
    }
  }

  // 4) Retirar tarjetas en Prisma que ya no existan en TTLock (evita fallos por “borradas”)
  if (ttlockCardIds.length > 0) {
    const toRetire = await prisma.nfcCard.findMany({
  where: {
    propertyId: String(params.propertyId),
    ttlockCardId: { notIn: ttlockCardIds },
    status: NfcCardStatus.AVAILABLE, // ✅ SOLO AVAILABLE
  },
  select: { id: true, ttlockCardId: true },
});

for (const c of toRetire) {
  await prisma.nfcCard.update({
    where: { id: c.id },
    data: {
      status: NfcCardStatus.RETIRED,
      label: `RETIRED (missing in TTLock) ${c.ttlockCardId}`,
    },
  });
}
    
  return {
      ttlockTotal: Number(resp?.total ?? list.length),
      guestTotal,
      cleaningTotal,
      upsertedCount: upserted.length,
      retiredCount: toRetire.length,
    };
  }

  return {
    ttlockTotal: Number(resp?.total ?? 0),
    guestTotal,
    cleaningTotal,
    upsertedCount: upserted.length,
    retiredCount: 0,
  };
}

// Cuenta disponibles por “tipo” usando label (Guest / Cleaning)
export async function countAvailableCardsByKind(
  prisma: PrismaClient,
  params: { propertyId: string }
) {
  const cards = await prisma.nfcCard.findMany({
    where: { propertyId: String(params.propertyId), status: NfcCardStatus.AVAILABLE },
    select: { label: true },
  });

  let guest = 0;
  let cleaning = 0;

  for (const c of cards) {
    const kind = classifyCardName(c.label ?? "");
    if (kind === "GUEST") guest++;
    if (kind === "CLEANING") cleaning++;
  }

  return { guest, cleaning, total: cards.length };
}

export async function assignNfcCards(
  prisma: PrismaClient,
  params: AssignParams
) {
  const { reservationId, ttlockLockId, propertyId, role, startsAt, endsAt, count } = params;

  if (count <= 0) return [];


 // 1) Buscar tarjetas disponibles (separadas por rol usando label)
 const roleFilter =
  role === "CLEANING"
    ? { label: { startsWith: "Cleaning Service-", mode: "insensitive" as const } }
    : { label: { startsWith: "Guest-", mode: "insensitive" as const } };

const cards = await prisma.nfcCard.findMany({
  where: {
    propertyId,
    status: NfcCardStatus.AVAILABLE,
    ...roleFilter,
  },
  orderBy: { createdAt: "asc" },
  take: count,
});

  if (cards.length < count) {
    throw new Error(
      `Not enough NFC cards AVAILABLE. Needed=${count} found=${cards.length}`
    );
  }

  // 2) Marcar como ASSIGNED (transacción)
  const updatedCards = await prisma.$transaction(
    cards.map((c) =>
      prisma.nfcCard.update({
        where: { id: c.id },
        data: { status: NfcCardStatus.ASSIGNED },
      })
    )
  );

  const assignments: any[] = [];

   // 3) Activar vigencia en TTLock + crear assignment
  for (const c of updatedCards) {
    try {
      await ttlockChangeCardPeriod({
        lockId: Number(ttlockLockId),
        cardId: Number(c.ttlockCardId),
        startDate: startsAt.getTime(),
        endDate: endsAt.getTime(),
        changeType: 2,
      });

      const a = await prisma.nfcAssignment.create({
        data: {
          reservationId,
          nfcCardId: c.id,
          role,
          status: NfcAssignmentStatus.ACTIVE,
          startsAt,
          endsAt,
        },
        include: { nfcCard: true },
      });

      assignments.push(a);
    } catch (e: any) {
      const errMsg = String(e?.message ?? e);

      // 1️⃣ Card borrada en TTLock → RETIRED
      if (isCardMissingError(e)) {
        await prisma.nfcAssignment.create({
          data: {
            reservationId,
            nfcCardId: c.id,
            role,
            status: NfcAssignmentStatus.FAILED,
            startsAt,
            endsAt,
            lastError: `CARD_MISSING: ${errMsg}`,
          },
        });

        await prisma.nfcCard.update({
          where: { id: c.id },
          data: { status: NfcCardStatus.RETIRED },
        });

        continue;
      }

      // 2️⃣ Error retryable (gateway offline, timeout, sync delay)
      if (isRetryableTtlockError(e)) {
        await prisma.nfcAssignment.create({
          data: {
            reservationId,
            nfcCardId: c.id,
            role,
            status: NfcAssignmentStatus.FAILED,
            startsAt,
            endsAt,
            lastError: `RETRYABLE: ${errMsg}`,
          },
        });

        // ⚠️ NO liberar la tarjeta → se queda ASSIGNED para retry
        continue;
      }

      // 3️⃣ Error fatal → liberar tarjeta
      await prisma.nfcAssignment.create({
        data: {
          reservationId,
          nfcCardId: c.id,
          role,
          status: NfcAssignmentStatus.FAILED,
          startsAt,
          endsAt,
          lastError: `FATAL: ${errMsg}`,
        },
      });

      await prisma.nfcCard.update({
        where: { id: c.id },
        data: { status: NfcCardStatus.AVAILABLE },
      });

      throw e;
    }
  }

  // ✅ AQUÍ ESTABA LO QUE TE FALTABA
  return assignments;
}

/**
 * Vence TODAS las tarjetas activas de una reserva y las libera (AVAILABLE).
 * Esto se llama típicamente en checkout.
 */
export async function unassignAllNfcForReservation(
  prisma: PrismaClient,
  params: { reservationId: string; ttlockLockId: number }
) {
  const { reservationId, ttlockLockId } = params;

  const active = await prisma.nfcAssignment.findMany({
    where: { reservationId, status: NfcAssignmentStatus.ACTIVE },
    include: { nfcCard: true },
  });

  let ended = 0;

  for (const a of active) {
    try {
      // vencer inmediatamente (recomendado vs delete)
      const now = Date.now();
      await ttlockChangeCardPeriod({
        lockId: Number(ttlockLockId),
        cardId: Number(a.nfcCard.ttlockCardId),
        startDate: now - 60_000,
        endDate: now - 30_000,
        changeType: 2,
      });

      await prisma.nfcAssignment.update({
        where: { id: a.id },
        data: { status: NfcAssignmentStatus.ENDED },
      });

      await prisma.nfcCard.update({
        where: { id: a.nfcCardId },
        data: { status: NfcCardStatus.AVAILABLE },
      });

      ended++;
    } catch (e: any) {
      // Si no pudimos vencer en TTLock, marcamos FAILED y NO liberamos la tarjeta (seguridad)
      await prisma.nfcAssignment.update({
        where: { id: a.id },
        data: {
          status: NfcAssignmentStatus.FAILED,
          lastError: String(e?.message ?? e),
        },
      });
    }
  }

  return { ended, totalActive: active.length };
}
