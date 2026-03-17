// src/services/nfc.service.ts
import {
  PrismaClient,
  Prisma,
  NfcCardStatus,
  NfcAssignmentStatus,
  NfcAssignmentRole,
} from "@prisma/client";

import {
  ttlockChangeCardPeriod,
  ttlockListCards,
} from "../ttlock/ttlock.card";

type AssignParams = {
  reservationId: string;
  ttlockLockId: number;
  propertyId: string;
  role: Prisma.NfcAssignmentRole; // "GUEST" | "CLEANING"
  startsAt: Date;
  endsAt: Date;
  count: number; // cantidad de tarjetas a asignar
  skipTtlock?: boolean; // ✅ si true, NO llama a TTLock changePeriod (solo DB)
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

  const list: any[] =
  Array.isArray(resp?.list) ? resp.list :
  Array.isArray(resp?.cardList) ? resp.cardList :
  [];

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

  // 1) Buscar tarjetas disponibles por rol
  const roleFilter =
    role === "CLEANING"
      ? { label: { startsWith: "Cleaning Service-", mode: "insensitive" as const } }
      : { label: { startsWith: "Guest-", mode: "insensitive" as const } };

  const cards = await prisma.nfcCard.findMany({
    where: {
      propertyId: String(propertyId),
      status: NfcCardStatus.AVAILABLE,
      ...roleFilter,
    },
    distinct: ["ttlockCardId"],
    orderBy: [{ ttlockCardId: "asc" }],
    // OJO: aquí traemos un poquito más para poder "completar" si alguna se claim-ea por otro flujo
    take: Math.max(count * 3, count),
  });

  if (cards.length < count) {
    throw new Error(`Not enough UNIQUE NFC cards. Needed=${count} found=${cards.length}`);
  }

  const assignments: any[] = [];

  for (const c of cards) {
    if (assignments.length >= count) break;

    // ✅ CLAIM atómico: solo si aún está AVAILABLE
    const claimed = await prisma.nfcCard.updateMany({
      where: { id: c.id, status: NfcCardStatus.AVAILABLE },
      data: { status: NfcCardStatus.ASSIGNED },
    });

    // si alguien ya la tomó, sigue con la próxima
    if (claimed.count === 0) continue;

    try {
      // ✅ Crea assignment SIEMPRE (aunque skipTtlock=true)
      const a = await prisma.nfcAssignment.create({
        data: {
          reservationId,
          nfcCardId: c.id,
          role,
          status: NfcAssignmentStatus.ACTIVE,
          startsAt,
          endsAt,
        },
      });

      assignments.push(a);

       // ✅ Solo salta TTLock si el boolean es EXACTAMENTE true
       if (params.skipTtlock === true) {
         continue;
       }

      // ✅ TTLock: programar vigencia (solo cuando skipTtlock=false)
      await ttlockChangeCardPeriod({
        lockId: Number(ttlockLockId),
        cardId: Number(c.ttlockCardId),
        startDate: startsAt.getTime(),
        endDate: endsAt.getTime(),
        changeType: 2,
      });

    } catch (e: any) {
      const errMsg = String(e?.message ?? e);

      console.error("[NFC] assign FAILED", {
        reservationId,
        lockId: Number(ttlockLockId),
        cardId: Number(c.ttlockCardId),
        label: c.label,
        err: errMsg,
        skipTtlock: Boolean(params.skipTtlock),
      });

      // ✅ Si falló algo en DB (o en TTLock) revertimos el claim para no “quemar” card
      await prisma.nfcCard.update({
        where: { id: c.id },
        data: { status: NfcCardStatus.AVAILABLE },
      }).catch(() => {});

      // Si ya habíamos creado assignment y quieres marcarlo FAILED, lo dejamos como está
      // (no intentamos adivinar su id aquí). Si quieres, lo afinamos luego.

      // En modo estricto: abortar para que el caller vea el error
      throw e;
    }
  }

  if (assignments.length < count) {
    throw new Error(`Not enough NFC cards could be claimed. Needed=${count} got=${assignments.length}`);
  }

  return assignments;
}


export async function dedupeNfcCards(prisma: PrismaClient, propertyId: string) {
  const cards = await prisma.nfcCard.findMany({
    where: { propertyId },
    orderBy: { createdAt: "asc" },
  });

// ✅ Seatbelt: evita duplicar la misma tarjeta TTLock (ttlockCardId)
const uniqueCards = [];
const seen = new Set<number>();

for (const c of cards) {
  if (seen.has(Number(c.ttlockCardId))) continue;
  seen.add(Number(c.ttlockCardId));
  uniqueCards.push(c);
}

if (uniqueCards.length < count) {
  throw new Error(`Not enough UNIQUE NFC cards. Needed=${count} found=${uniqueCards.length}`);
}

  const keepByTt = new Map<number, string>(); // ttlockCardId -> keepId
  let retired = 0;

  for (const c of cards) {
    const tt = c.ttlockCardId;
    const keepId = keepByTt.get(tt);

    if (!keepId) {
      keepByTt.set(tt, c.id);
      continue;
    }

    // mueve assignments del duplicado al keep
    await prisma.nfcAssignment.updateMany({
      where: { nfcCardId: c.id },
      data: { nfcCardId: keepId },
    });

    // retira duplicado
    await prisma.nfcCard.update({
      where: { id: c.id },
      data: { status: NfcCardStatus.RETIRED },
    });

    retired++;
  }

  return { ok: true, propertyId, total: cards.length, kept: keepByTt.size, retired };
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
    include: { NfcCard: true },
  });

  let ended = 0;

  for (const a of active) {
    try {
      const now = Date.now();

      await ttlockChangeCardPeriod({
        lockId: Number(ttlockLockId),
        cardId: Number(a.NfcCard.ttlockCardId),
        startDate: now - 60_000,
        endDate: now - 30_000,
        changeType: 2,
      });

      await prisma.nfcAssignment.update({
        where: { id: a.id },
        data: { status: NfcAssignmentStatus.ENDED, lastError: null },
      });

      await prisma.nfcCard.update({
        where: { id: a.nfcCardId },
        data: { status: NfcCardStatus.AVAILABLE },
      });

      ended++;
    } catch (e: any) {
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

export async function unassignGuestNfcForReservation(
  prisma: PrismaClient,
  params: { reservationId: string; ttlockLockId: number }
) {
  const { reservationId, ttlockLockId } = params;

  const activeGuest = await prisma.nfcAssignment.findMany({
    where: {
      reservationId,
      role: NfcAssignmentRole.GUEST,
      status: NfcAssignmentStatus.ACTIVE,
    },
    include: { NfcCard: true },
  });

  let ended = 0;

  for (const a of activeGuest) {
    try {
      const now = Date.now();

      await ttlockChangeCardPeriod({
        lockId: Number(ttlockLockId),
        cardId: Number(a.NfcCard.ttlockCardId),
        startDate: now - 60_000,
        endDate: now - 30_000,
        changeType: 2,
      });

      await prisma.nfcAssignment.update({
        where: { id: a.id },
        data: { status: NfcAssignmentStatus.ENDED, lastError: null },
      });

      await prisma.nfcCard.update({
        where: { id: a.nfcCardId },
        data: { status: NfcCardStatus.AVAILABLE },
      });

      ended++;
    } catch (e: any) {
      await prisma.nfcAssignment.update({
        where: { id: a.id },
        data: {
          status: NfcAssignmentStatus.FAILED,
          lastError: String(e?.message ?? e),
        },
      });
    }
  }

  return { ended, totalActive: activeGuest.length };
}