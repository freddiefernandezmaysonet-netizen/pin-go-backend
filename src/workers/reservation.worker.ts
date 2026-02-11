// src/workers/reservation.worker.ts
import 'dotenv/config';
import {
  PrismaClient,
  PaymentState,
  AccessStatus,
  AccessMethod,
  AccessGrantType,
  StaffAssignmentStatus,
  StaffAccessMethod,
} from '@prisma/client';

import { isOrgEntitled } from "../services/billing.entitlement";

import { activateGrant, deactivateGrant } from "../services/ttlock/ttlock.brain";

import { sendSms } from '../integrations/twilio/twilio.client';
import { sendGuestAccessLinkSms } from "../services/guestLinkSms.service";
import { expireNfcAssignments } from "../services/nfc-expire.service";
import { retryPendingNfcSync } from "../services/nfc-sync.service";
import { retryNfcAssignments } from "../services/nfc-retry.service";

console.log("[reservation.worker] BOOT", new Date().toISOString());

const prisma = new PrismaClient();

function phoneToPasscode(phone?: string) {
  if (!phone) return null;

  // quitar todo lo que no sea número
  const digits = phone.replace(/\D/g, "");

  // usar los últimos 7 dígitos
  if (digits.length >= 7) {
    return digits.slice(-7);
  }

  return null;
}

// ===== TTLOCK MODE =====
// 1 = Bluetooth / SDK
// 2 = Gateway (recomendado producción)
const TTLOCK_ADD_TYPE = Number(process.env.TTLOCK_ADD_TYPE ?? 2);
const TTLOCK_DELETE_TYPE = Number(process.env.TTLOCK_DELETE_TYPE ?? 2);

// ====== CONFIG ======
const WORKER_NAME = 'reservation.worker';
const POLL_MS = Number(process.env.RESERVATION_WORKER_POLL_MS ?? 10_000);
const BATCH_SIZE = Number(process.env.RESERVATION_WORKER_BATCH_SIZE ?? 20);
const REMINDER_ON = process.env.GUEST_LINK_SMS_REMINDER === "1";
const REMINDER_HOURS = Number(process.env.GUEST_LINK_REMINDER_HOURS ?? 24);

async function processGuestLinkReminders(now: Date) {
  if (!REMINDER_ON) return;

  const from = new Date(now.getTime() + (REMINDER_HOURS - 1) * 60 * 60 * 1000);
  const to   = new Date(now.getTime() + (REMINDER_HOURS + 1) * 60 * 60 * 1000);

  const upcoming = await prisma.reservation.findMany({
    where: {
      checkIn: { gte: from, lte: to },
      paymentState: PaymentState.PAID,
      guestToken: { not: null },
      guestPhone: { not: null },

      // ✅ no enviar dos veces (idempotente por tipo)
      guestLinkReminderLogs: { none: { kind: "CHECKIN_LINK" } },
    },
    take: 50,
    orderBy: { checkIn: "asc" },

    // ✅ necesitamos guestPhone para guardar 'to'
    select: { id: true, guestPhone: true },
  });

  if (upcoming.length === 0) return;

  log("processGuestLinkReminders", { count: upcoming.length });

  for (const r of upcoming) {
    try {
      // 1️⃣ Crear el log primero (para no spamear) + idempotencia por unique(reservationId, kind)
      await prisma.guestLinkReminderLog.upsert({
        where: {
          reservationId_kind: {
            reservationId: r.id,
            kind: "CHECKIN_LINK",
          },
        },
        create: {
          reservationId: r.id,
          kind: "CHECKIN_LINK",
          channel: "sms",
          to: r.guestPhone ?? "unknown",
          provider: "twilio",
          status: "FAILED", // por defecto (safe)
        },
        update: {}, // si ya existe, no hace nada
      });

      // 2️⃣ Intentar enviar el SMS
      const sent = await sendGuestAccessLinkSms(prisma, r.id, "REMINDER");

      // 3️⃣ Actualizar resultado
      await prisma.guestLinkReminderLog.update({
        where: {
          reservationId_kind: {
            reservationId: r.id,
            kind: "CHECKIN_LINK",
          },
        },
        data: {
          status: sent?.ok === true ? "SENT" : "FAILED",
          error: sent?.ok === true ? null : "SMS not confirmed",
        },
      });

      log(sent?.ok === true ? "Reminder SENT" : "Reminder FAILED", {
        reservationId: r.id,
      });
    } catch (e) {
      errLog("Reminder crashed", {
        reservationId: r.id,
        err: toErrString(e),
      });

      // 4️⃣ Marcar FAILED si explotó
      try {
        await prisma.guestLinkReminderLog.update({
          where: {
            reservationId_kind: {
              reservationId: r.id,
              kind: "CHECKIN_LINK",
            },
          },
          data: {
            status: "FAILED",
            error: toErrString(e),
          },
        });
      } catch {}
    }
  }
} // ✅ ESTA LLAVE ERA LA QUE TE FALTABA

// Si quieres permitir activación sin pago (por pruebas), pon ALLOW_UNPAID=1
const ALLOW_UNPAID = process.env.ALLOW_UNPAID === '1';

// SMS flags (separados)
const GUEST_SMS_ENABLED = process.env.GUEST_SMS_ENABLED === '1'; // recomendado: 0 hasta prod
const CLEANING_SMS_ENABLED = process.env.CLEANING_SMS_ENABLED === '1'; // recomendado: 0 hasta prod

function fmtUtc(d: Date) {
  return new Date(d).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

// ====== UTILS ======
function log(...args: any[]) {
  console.log(`[${new Date().toISOString()}] [${WORKER_NAME}]`, ...args);
}

function errLog(...args: any[]) {
  console.error(`[${new Date().toISOString()}] [${WORKER_NAME}]`, ...args);
}

function toErrString(e: unknown) {
  if (e instanceof Error) return `${e.name}: ${e.message}\n${e.stack ?? ''}`.trim();
  return String(e);
}

function maskPasscode(code: string) {
  if (code.length <= 2) return '**';
  return `${code.slice(0, 1)}***${code.slice(-1)}`;
}

function generatePasscode(len = 8) {
  let s = '';
  for (let i = 0; i < len; i++) s += Math.floor(Math.random() * 10);
  return s;
}

function formatLocal(dt: Date) {
  // Sin timezone específica por property por ahora; mejora futura
  return dt.toLocaleString();
}

// ====== TTLOCK ACTIONS (GUEST PASSCODE) ======

/**
 * Activa un AccessGrant según el método.
 * Implementado: PASSCODE_TIMEBOUND (TTLock keyboard pwd)
 */

// ====== STAFF HOOKS (CLEANING NFC/eKEY) ======

/**
 * Activación STAFF (NFC/eKey) – Hook.
 * Por ahora NO llama TTLock (para no romperte si el driver NFC no está listo).
 * Cuando conectes NFC real, implementas aquí.
 */
async function activateStaffAccess(_assignment: any, _grant: any) {
  // TODO: conectar TTLock NFC/eKey.
  return { ttlockPayload: null, ttlockRefId: null };
}

/**
 * Revocación STAFF – Hook.
 * Si tu staff usa TTLock NFC/eKey, aquí llamas delete/revoke.
 */
async function revokeStaffAccess(_assignment: any, _grant: any) {
  // TODO: conectar TTLock NFC/eKey revoke.
  return true;
}

// ====== CORE QUERIES (GUEST ONLY) ======

async function fetchDueCheckins(now: Date) {
  const paymentFilter = ALLOW_UNPAID ? undefined : ({ paymentState: PaymentState.PAID } as const);
const debug = await prisma.accessGrant.count({
  where: {
    type: AccessGrantType.GUEST,
    status: AccessStatus.PENDING,
    startsAt: { lte: now },
    endsAt: { gt: now },
  },
});
log("DEBUG pending grants in-window", { debug });

const debugRes = await prisma.reservation.count({
  where: { checkIn: { lte: now }, checkOut: { gt: now } },
});
log("DEBUG reservations in-window", { debugRes });

 
 return prisma.reservation.findMany({
    where: {
      checkIn: { lte: now },
      checkOut: { gt: now },
      ...(paymentFilter ?? {}),
      accessGrants: {
        some: {
          type: AccessGrantType.GUEST,
          status: AccessStatus.PENDING,
          startsAt: { lte: now },
          endsAt: { gt: now },
        },
        none: {
          type: AccessGrantType.GUEST,
          status: AccessStatus.ACTIVE,
          startsAt: { lte: now },
          endsAt: { gt: now },
        },
      },
    },
    take: BATCH_SIZE,
    orderBy: { checkIn: "asc" },
    include: {
      // ✅ NECESARIO para el billing gate (Cambio 2)
      property: { select: { organizationId: true } },

      accessGrants: {
        where: {
          type: AccessGrantType.GUEST,
          status: AccessStatus.PENDING,
          startsAt: { lte: now },
          endsAt: { gt: now },
        },
        orderBy: { startsAt: "asc" },
        take: 5,
        include: {
          lock: true,
          // ✅ removido: reservation.select.guestPhone (usa r.guestPhone)
        },
      },
    },
  });
}

async function fetchDueCheckouts(now: Date) {
  return prisma.reservation.findMany({
    where: {
      accessGrants: {
        some: {
          type: AccessGrantType.GUEST,
          status: AccessStatus.ACTIVE,
          endsAt: { lte: now },
        },
      },
    },
    take: BATCH_SIZE,
    orderBy: { updatedAt: 'asc' },
    include: {
      property: { select: { organizationId: true } }, // ✅ añadido
      accessGrants: {
        where: {
          type: AccessGrantType.GUEST,
          status: AccessStatus.ACTIVE,
          endsAt: { lte: now },
        },
        orderBy: { endsAt: 'asc' },
        take: 10,
        include: { lock: true },
      },
    },
  });
}

// ====== CLEANING (STAFF) QUERIES ======

async function fetchDueCleaningAssignments(now: Date) {
  return prisma.staffAssignment.findMany({
    where: {
      status: StaffAssignmentStatus.SCHEDULED,
      startsAt: { lte: now },
      endsAt: { gt: now },
      staffMember: { isActive: true },
    },
    take: BATCH_SIZE,
    orderBy: { startsAt: 'asc' },
    include: {
      reservation: { include: { property: true } },
      staffMember: true,
      accessGrant: { include: { lock: true } },
    },
  });
}

async function fetchDueCleaningEnds(now: Date) {
  return prisma.staffAssignment.findMany({
    where: {
      status: StaffAssignmentStatus.ACTIVE,
      endsAt: { lte: now },
      accessGrantId: { not: null },
    },
    take: BATCH_SIZE,
    orderBy: { endsAt: 'asc' },
    include: {
      reservation: { include: { property: true } },
      staffMember: true,
      accessGrant: { include: { lock: true } },
    },
  });
}

async function ensureStaffGrantForAssignment(a: any) {
  if (a.accessGrant) return a.accessGrant;

  // Primer lock activo de la property (simple y estable para ahora)
  const lock = await prisma.lock.findFirst({
    where: { propertyId: a.reservation.propertyId, isActive: true },
    orderBy: { createdAt: 'asc' },
  });

  if (!lock) throw new Error(`No active lock found for property ${a.reservation.propertyId}`);

  const grant = await prisma.accessGrant.create({
    data: {
      lockId: lock.id,
      reservationId: a.reservationId,

      type: AccessGrantType.STAFF,
      staffMemberId: a.staffMemberId,

      // Placeholder: hasta que conectes TTLock NFC (si amplías enums, lo ajustas)
      method: AccessMethod.AUTHORIZED_ADMIN,

      status: AccessStatus.PENDING,
      startsAt: a.startsAt,
      endsAt: a.endsAt,

      // guardamos referencia NFC si existe
      ttlockRefId: a.staffMember.ttlockCardRef ?? null,
    },
    include: { lock: true },
  });

  await prisma.staffAssignment.update({
    where: { id: a.id },
    data: { accessGrantId: grant.id },
  });

  return grant;
}

// ====== PROCESSORS ======

async function processCheckins(now: Date) {
  const reservations = await fetchDueCheckins(now);
  log('processCheckins result', { count: reservations.length });

  if (reservations.length === 0) return;

  log(`Checkins due: ${reservations.length}`);

for (const r of reservations) {
  for (const grant of r.accessGrants) {
    if (grant.type !== AccessGrantType.GUEST) continue;

    try {
  // Guard-rail: asegura que siga PENDING (NO lo pongas ACTIVE aquí)
  const locked = await prisma.accessGrant.updateMany({
    where: { id: grant.id, status: AccessStatus.PENDING },
    data: { lastError: null },
  });

  if (locked.count === 0) continue;

  // ===== CAMBIO 2: BILLING GATE (VA AQUÍ) =====
  const organizationId = (r as any).property?.organizationId;

  if (!organizationId) {
    await prisma.accessGrant.update({
      where: { id: grant.id },
      data: {
        status: AccessStatus.FAILED,
        lastError: "Missing reservation.property.organizationId",
      },
    });
    continue;
  }

  const entitled = await isOrgEntitled(organizationId, now);

  if (!entitled.ok) {
    await prisma.accessGrant.update({
      where: { id: grant.id },
      data: {
        status: AccessStatus.SUSPENDED,
        lastError: `Blocked by billing: ${entitled.reason}`,
      },
    });
    continue; // ⛔ NO TTLOCK
  }
  // ===== FIN CAMBIO 2 =====

// 1) Activar grant usando TTLock Brain (maneja TTLock + Prisma)
const res = await activateGrant(grant.id);
if ((res as any)?.ok === true || (res as any)?.skipped === true) {
  await prisma.accessGrant.update({ where: { id: grant.id }, data: { lastError: null } });
}

// 3) SMS guest (flag)
const phone = r.guestPhone;
const ok = (res as any)?.ok === true;
const code = (res as any)?.passcodePlain ?? null;

  if (GUEST_SMS_ENABLED) {
    try {
      if (!phone) {
        log(`Guest SMS skipped: reservation ${r.id} has no guestPhone`);
      } else if (!code) {
        log(`Guest SMS skipped: no passcode generated for grant ${grant.id}`);
      } else {
        const body =
          `Pin&Go Access ✅\n` +
          `Hola ${r.guestName}, tu código de entrada es: ${code}\n` +
          `Válido hasta: ${formatLocal(new Date(grant.endsAt))}`;

        const sent = await sendSms(phone, body);
        log(`Guest SMS sent to ${phone}:`, sent);
      }
    } catch (e) {
      const msg = toErrString(e);
      errLog(`Guest SMS FAILED for reservation ${r.id} grant ${grant.id} -> ${msg}`);
      await prisma.accessGrant.update({
        where: { id: grant.id },
        data: { lastError: `SMS_FAILED: ${msg}` },
      });
    }
  }

  log(`Activated GUEST grant ${grant.id} (reservation ${r.id})`);

  } catch (e) {
        const msg = toErrString(e);

        await prisma.accessGrant.update({
          where: { id: grant.id },
          data: { lastError: msg },
        });

        errLog(`Activation FAILED grant ${grant.id} (reservation ${r.id}) -> ${msg}`);
      }
    }
  }
}

async function processCheckouts(now: Date) {
  const reservations = await fetchDueCheckouts(now);
  log('processCheckouts result', { count: reservations.length });

  if (reservations.length === 0) return;

  log(`Checkouts due: ${reservations.length}`);

  for (const r of reservations) {
    for (const grant of r.accessGrants) {
      if (grant.type !== AccessGrantType.GUEST) continue;

      try {
        // Guard-rail: asegura que siga ACTIVE
        const locked = await prisma.accessGrant.updateMany({
          where: { id: grant.id, status: AccessStatus.ACTIVE },
          data: { lastError: null },
        });

        if (locked.count === 0) continue;
      
        // 1) Revocar usando TTLock Brain (maneja TTLock + Prisma)
await deactivateGrant(grant.id);

// 2) Limpia error si quedó alguno (opcional, safe)
await prisma.accessGrant.update({
  where: { id: grant.id },
  data: { lastError: null },
});


        log(`Revoked GUEST grant ${grant.id} (reservation ${r.id})`);
      } catch (e) {
        const msg = toErrString(e);

        // ⚠️ NO pongas FAILED aquí: deja ACTIVE para reintento
        await prisma.accessGrant.update({
          where: { id: grant.id },
          data: { lastError: msg },
        });

        errLog(`Deactivation FAILED grant ${grant.id} (reservation ${r.id}) -> ${msg}`);
      }
    }
  }
}


// ---- Cleaning processors ----

async function processCleaningActivations(now: Date) {
  const assignments = await fetchDueCleaningAssignments(now);
  log('processCleaningActivations result', { count: assignments.length });

  if (assignments.length === 0) return;

  for (const a of assignments) {
    try {
      // Guard-rail: lock SCHEDULED -> ACTIVE (idempotente)
      const locked = await prisma.staffAssignment.updateMany({
        where: { id: a.id, status: StaffAssignmentStatus.SCHEDULED },
        data: { status: StaffAssignmentStatus.ACTIVE, lastError: null },
      });

      if (locked.count === 0) continue;

      const grant = await ensureStaffGrantForAssignment(a);

      // Guard-rail grant: solo PENDING -> (seguimos) y luego lo ponemos ACTIVE
      const grantLocked = await prisma.accessGrant.updateMany({
        where: { id: grant.id, status: AccessStatus.PENDING },
        data: { lastError: null },
      });

      if (grantLocked.count === 0) {
        log('Cleaning activation skipped (grant not PENDING)', { grantId: grant.id });
        continue;
      }
/*
      const payload = await activateGrant(grant, r.guestPhone ?? undefined);

      await prisma.accessGrant.update({
        where: { id: grant.id },
        data: {
          status: AccessStatus.ACTIVE,
          lastError: null,
          ttlockPayload: payload?.ttlockPayload ?? grant.ttlockPayload ?? null,
          ttlockRefId: payload?.ttlockRefId ?? grant.ttlockRefId ?? null,
        },
      });
*/
      // ===== Cleaning SMS START =====
      if (CLEANING_SMS_ENABLED) {
        try {
          const phone = a.staffMember?.phoneE164;
          if (!phone) {
            log(`Cleaning SMS skipped: staff ${a.staffMemberId} has no phoneE164`);
          } else {
            const body =
              `Pin&Go 🧼 Limpieza ACTIVADA\n` +
              `Asignado: ${a.staffMember?.fullName ?? 'Staff'}\n` +
              `Propiedad: ${a.reservation?.property?.name ?? 'N/A'}\n` +
              `Unidad: ${a.reservation?.roomName ?? 'N/A'}\n` +
              `Ventana: ${fmtUtc(a.startsAt)} - ${fmtUtc(a.endsAt)}\n` +
              `Acceso válido solo en esta ventana.`;

            const sent = await sendSms(phone, body);

            await prisma.messageLog.create({
              data: {
                channel: 'sms',
                to: phone,
                from: process.env.TWILIO_FROM_NUMBER ?? process.env.TWILIO_FROM ?? null,
                body,
                provider: 'twilio',
                providerMessageId: (sent as any)?.sid ?? null,
                status: 'SENT',
                accessGrantId: a.accessGrantId ?? null,
              },
            });

            log(`Cleaning SMS sent (START) to ${phone}`);
          }
        } catch (e) {
          errLog(`Cleaning SMS START FAILED assignment ${a.id} -> ${toErrString(e)}`);
        }
      }

      log(
        `Cleaning ACTIVE assignment ${a.id} -> grant ${grant.id} (reservation ${a.reservationId})`
      );
    } catch (e) {
      const msg = toErrString(e);

      await prisma.staffAssignment.update({
        where: { id: a.id },
        data: {
          status: StaffAssignmentStatus.FAILED,
          lastError: msg,
          retryCount: { increment: 1 },
        },
      });

      errLog(`Cleaning activation FAILED assignment ${a.id} -> ${msg}`);
    }
  }
}

async function processCleaningEnds(now: Date) {
  const assignments = await fetchDueCleaningEnds(now);
  log('processCleaningEnds result', { count: assignments.length });

  if (assignments.length === 0) return;

  for (const a of assignments) {
    const grant = a.accessGrant;
    if (!grant) continue;

    try {
      // Guard-rail: solo si grant sigue ACTIVE
      const locked = await prisma.accessGrant.updateMany({
        where: { id: grant.id, status: AccessStatus.ACTIVE },
        data: { lastError: null },
      });

      if (locked.count === 0) {
        await prisma.staffAssignment.update({
          where: { id: a.id },
          data: { status: StaffAssignmentStatus.COMPLETED, lastError: null },
        });
        continue;
      }

      await revokeStaffAccess(a, grant);

      await prisma.accessGrant.update({
        where: { id: grant.id },
        data: { status: AccessStatus.REVOKED, lastError: null },
      });

      await prisma.staffAssignment.update({
        where: { id: a.id },
        data: { status: StaffAssignmentStatus.COMPLETED, lastError: null },
      });

      // ===== Cleaning SMS END =====
      if (CLEANING_SMS_ENABLED) {
        try {
          const phone = a.staffMember?.phoneE164;
          if (!phone) {
            log(`Cleaning SMS skipped: staff ${a.staffMemberId} has no phoneE164`);
          } else {
            const body =
              `Pin&Go ✅ Limpieza FINALIZADA\n` +
              `Asignado: ${a.staffMember?.fullName ?? 'Staff'}\n` +
              `Propiedad: ${a.reservation?.property?.name ?? 'N/A'}\n` +
              `Unidad: ${a.reservation?.roomName ?? 'N/A'}\n` +
              `Fin: ${fmtUtc(a.endsAt)}\n` +
              `Acceso expiró automáticamente.`;

            const sent = await sendSms(phone, body);

            await prisma.messageLog.create({
              data: {
                channel: 'sms',
                to: phone,
                from: process.env.TWILIO_FROM_NUMBER ?? process.env.TWILIO_FROM ?? null,
                body,
                provider: 'twilio',
                providerMessageId: (sent as any)?.sid ?? null,
                status: 'SENT',
                accessGrantId: a.accessGrantId ?? null,
              },
            });

            log(`Cleaning SMS sent (END) to ${phone}`);
          }
        } catch (e) {
          errLog(`Cleaning SMS END FAILED assignment ${a.id} -> ${toErrString(e)}`);
        }
      }

      log(`Cleaning COMPLETED assignment ${a.id} -> revoked grant ${grant.id}`);
    } catch (e) {
      const msg = toErrString(e);

      await prisma.accessGrant.update({
        where: { id: grant.id },
        data: { status: AccessStatus.FAILED, lastError: msg },
      });

      await prisma.staffAssignment.update({
        where: { id: a.id },
        data: {
          status: StaffAssignmentStatus.FAILED,
          lastError: msg,
          retryCount: { increment: 1 },
        },
      });

      errLog(`Cleaning end FAILED assignment ${a.id} -> ${msg}`);
    }
  }
}

// ====== LOOP ======
let shuttingDown = false;

async function tick() {
  if (shuttingDown) return;

  const now = new Date();
  log('tick', { now: now.toISOString() });

  try {
    await processCheckins(now);
  } catch (e) {
    errLog('runCheckins crashed:', toErrString(e));
  }

try {
  const r = await retryPendingNfcSync(prisma, now);
  if (r.activated > 0) log("nfc-retry", r);
} catch (e) {
  errLog("nfc-retry crashed:", toErrString(e));
}

  try {
    await processGuestLinkReminders(now);
  } catch (e) {
    errLog("runGuestLinkReminders crashed:", toErrString(e));
  }

  try {
    await processCheckouts(now);
  } catch (e) {
    errLog('runCheckouts crashed:', toErrString(e));
  }

try {
  const r = await retryNfcAssignments(prisma, now);
  if (r.activated || r.retired) log("nfc-retry", r);
} catch (e) {
  errLog("nfc-retry crashed:", toErrString(e));
}

  try {
    const r = await expireNfcAssignments(prisma, now);
    if (r.expired > 0) log("nfc-expire", { ended: r.expired });
  } catch (e) {
    errLog("nfc-expire crashed:", toErrString(e));
  }

  // Limpieza (STAFF) corre en su propio carril
  try {
    await processCleaningActivations(now);
  } catch (e) {
    errLog('runCleaningActivations crashed:', toErrString(e));
  }

  try {
    await processCleaningEnds(now);
  } catch (e) {
    errLog('runCleaningEnds crashed:', toErrString(e));
  }
}

async function start() {
  log(
    `Starting. poll=${POLL_MS}ms batch=${BATCH_SIZE} allow_unpaid=${ALLOW_UNPAID ? 'yes' : 'no'}`
  );
  log(
    `SMS flags: guest=${GUEST_SMS_ENABLED ? 'on' : 'off'} cleaning=${
      CLEANING_SMS_ENABLED ? 'on' : 'off'
    }`
  );

  log(
  "ENV DATABASE_URL =",
  process.env.DATABASE_URL ? process.env.DATABASE_URL : "❌ UNDEFINED"
);

  // Primer tick inmediato
  await tick();

  const interval = setInterval(() => void tick(), POLL_MS);

  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;

    log(`Received ${signal}. Shutting down...`);
    clearInterval(interval);

    try {
      await prisma.$disconnect();
      log("Disconnected Prisma. Bye.");
    } catch (e) {
      errLog("Error on disconnect:", toErrString(e));
    } finally {
      process.exit(0);
    }
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

void start().catch((e) => {
  errLog('Fatal start error:', toErrString(e));
  process.exit(1);
});
