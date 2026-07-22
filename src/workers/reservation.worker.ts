// src/workers/reservation.worker.ts
import dotenv from "dotenv";
dotenv.config({ path: "./.env", override: true });
import {
  PaymentState,
  ReservationStatus,
  AccessStatus,
  AccessMethod,
  AccessGrantType,
  StaffAssignmentStatus,
  StaffAccessMethod,
  NfcAssignmentRole,
  NfcAssignmentStatus,
  GuestJourneyState,
  GuestAccessReleaseStatus,
} from "@prisma/client";
import { prisma } from "../lib/prisma";
import { isOrgEntitled } from "../services/billing.entitlement";
import { activateGrant, deactivateGrant } from "../services/ttlock/ttlock.brain";
import { assignNfcCards } from "../services/nfc.service";
import {
  sendGuestPasscodeSms,
  sendCleaningStartSms,
  sendCleaningEndSms,
} from "../services/messaging.service";
import {
  sendLoggedEmail,
} from "../services/email-delivery.service";
import {
  sendGuestVerificationReminder,
} from "../services/guest-verification-reminder.service";
import {
  sendGuestAccessPasscodeEmail,
} from "../lib/mailer";
import { sendGuestAccessLinkSms } from "../services/guestLinkSms.service";
import { sendPreCheckinSms } from "../services/preCheckinSms.service";
import { sendCheckoutSms } from "../services/checkoutSms.service";
import { sendCleaningReadySms } from "../services/cleaningReadySms.service";
import { resolveGuestLanguage } from "../services/guest-language.service";
import { resolveOrganizationGuestReplyTo } from "../services/organization-guest-email.service";
import { expireNfcAssignments } from "../services/nfc-expire.service";
import { expireGuestNfcAssignments } from "../services/nfc-expire.service";
import { expireCleaningNfcAssignments } from "../services/nfc-expire.service";
import { retryPendingNfcSync } from "../services/nfc-sync.service";
import { ttlockChangeCardPeriod, ttlockListCards } from "../ttlock/ttlock.card";
import { ttlockChangePasscode } from "../ttlock/ttlock.passcode";
import { NfcCardStatus } from "@prisma/client";
import { unassignAllNfcForReservation } from "../services/nfc.service";
import { unassignGuestNfcForReservation } from "../services/nfc.service";
import { processPendingCleaningConfirmations } from "../services/cleaning-confirmation-dispatch.service";
import {
  markGuestJourneyReadyForArrival,
  scheduleGuestJourneyAccess,
} from "../services/guest-journey.service";


console.log("[reservation.worker] BOOT", new Date().toISOString());

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
const REMINDER_ON =
  process.env.GUEST_LINK_SMS_REMINDER ===
  "1";

const REMINDER_HOURS = Number(
  process.env.GUEST_LINK_REMINDER_HOURS ??
    24
);

async function processGuestLinkReminders(
  now: Date
) {
  if (!REMINDER_ON) return;

  const from = new Date(
    now.getTime() +
      (REMINDER_HOURS - 1) *
        60 *
        60 *
        1000
  );

  const to = new Date(
    now.getTime() +
      (REMINDER_HOURS + 1) *
        60 *
        60 *
        1000
  );

  const upcoming =
    await prisma.reservation.findMany({
      where: {
        checkIn: {
          gte: from,
          lte: to,
        },
        paymentState:
          PaymentState.PAID,
        guestToken: {
          not: null,
        },
        guestPhone: {
          not: null,
        },
        guestLinkReminderLogs: {
          none: {
            kind: "CHECKIN_LINK",
          },
        },
      },
      take: 50,
      orderBy: {
        checkIn: "asc",
      },
      select: {
        id: true,
        reservationNumber: true,
        guestPhone: true,
        externalRaw: true,
      },
    });

  if (upcoming.length === 0) {
    return;
  }

  log(
    "processGuestLinkReminders",
    {
      count: upcoming.length,
    }
  );

  for (const reservation of upcoming) {
    if (
      !hasGuestSmsConsent(
        reservation.externalRaw
      )
    ) {
      log(
        "Guest link reminder skipped",
        {
          reservationNumber:
            reservation.reservationNumber ??
            null,
          reservationId:
            reservation.id,
          reason:
            "SMS_CONSENT_NOT_GRANTED",
        }
      );

      continue;
    }

    try {
      await prisma.guestLinkReminderLog.upsert({
        where: {
          reservationId_kind: {
            reservationId:
              reservation.id,
            kind: "CHECKIN_LINK",
          },
        },
        create: {
          reservationId:
            reservation.id,
          kind: "CHECKIN_LINK",
          channel: "sms",
          to:
            reservation.guestPhone ??
            "unknown",
          provider: "twilio",
          status: "FAILED",
        },
        update: {},
      });

      const sent =
        await sendGuestAccessLinkSms(
          prisma,
          reservation.id,
          "REMINDER"
        );

      await prisma.guestLinkReminderLog.update({
        where: {
          reservationId_kind: {
            reservationId:
              reservation.id,
            kind: "CHECKIN_LINK",
          },
        },
        data: {
          status:
            sent?.ok === true
              ? "SENT"
              : "FAILED",
          error:
            sent?.ok === true
              ? null
              : sent?.error ??
                "SMS not confirmed",
        },
      });

      log(
        sent?.ok === true
          ? "Reminder SENT"
          : "Reminder FAILED",
        {
          reservationNumber:
            reservation.reservationNumber ??
            null,
          reservationId:
            reservation.id,
        }
      );
    } catch (error) {
      const errorMessage =
        toErrString(error);

      errLog(
        "Reminder crashed",
        {
          reservationNumber:
            reservation.reservationNumber ??
            null,
          reservationId:
            reservation.id,
          error: errorMessage,
        }
      );

      try {
        await prisma.guestLinkReminderLog.update({
          where: {
            reservationId_kind: {
              reservationId:
                reservation.id,
              kind: "CHECKIN_LINK",
            },
          },
          data: {
            status: "FAILED",
            error: errorMessage,
          },
        });
      } catch {
        // No bloquear el worker por un fallo del log.
      }
    }
  }
}

async function processGuestVerificationReminders(
  now: Date
) {
  const reminderFrom = new Date(
    now.getTime() +
      (REMINDER_HOURS - 1) *
        60 *
        60 *
        1000
  );

  const reminderTo = new Date(
    now.getTime() +
      (REMINDER_HOURS + 1) *
        60 *
        60 *
        1000
  );

  const reservations =
    await prisma.reservation.findMany({
      where: {
        status:
          ReservationStatus.ACTIVE,
        checkIn: {
          gte: reminderFrom,
          lte: reminderTo,
        },
        checkOut: {
          gt: now,
        },
        guestToken: {
          not: null,
        },
        guestJourney: {
          is: {
            currentState:
              GuestJourneyState
                .VERIFICATION_PENDING,
          },
        },
        OR: [
          {
            guestLinkReminderLogs: {
              none: {
                kind:
                  "VERIFICATION_REMINDER",
              },
            },
          },
          {
            guestLinkReminderLogs: {
              some: {
                kind:
                  "VERIFICATION_REMINDER",
                status: "FAILED",
              },
            },
          },
        ],
      },
      take: BATCH_SIZE,
      orderBy: {
        checkIn: "asc",
      },
      select: {
        id: true,
        reservationNumber: true,
      },
    });

  if (reservations.length === 0) {
    return;
  }

  log(
    "processGuestVerificationReminders",
    {
      count: reservations.length,
    }
  );

  for (const reservation of reservations) {
    try {
      const result =
        await sendGuestVerificationReminder(
          prisma,
          reservation.id
        );

      log(
        "Guest verification reminder processed",
        {
          reservationNumber:
            reservation.reservationNumber ??
            null,
          reservationId:
            reservation.id,
          reminderStatus:
            result.reminderStatus,
          emailStatus:
            result.emailStatus,
          smsStatus:
            result.smsStatus,
          skippedReason:
            result.skippedReason ??
            null,
        }
      );
    } catch (error) {
      errLog(
        "Guest verification reminder FAILED",
        {
          reservationNumber:
            reservation.reservationNumber ??
            null,
          reservationId:
            reservation.id,
          error:
            toErrString(error),
        }
      );
    }
  }
}

async function processPreCheckinMessages(
  now: Date
) {
  const TWO_HOURS =
    2 * 60 * 60 * 1000;

  const upcoming =
    await prisma.reservation.findMany({
      where: {
        checkIn: {
          gt: now,
          lte: new Date(
            now.getTime() + TWO_HOURS
          ),
        },
        paymentState:
          PaymentState.PAID,
        guestPhone: {
          not: null,
        },
        status:
          ReservationStatus.ACTIVE,
      },
      select: {
        id: true,
        reservationNumber: true,
        externalRaw: true,
      },
      take: 50,
      orderBy: {
        checkIn: "asc",
      },
    });

  if (upcoming.length === 0) {
    return;
  }

  log(
    "processPreCheckinMessages",
    {
      count: upcoming.length,
    }
  );

  for (const reservation of upcoming) {
    if (
      !hasGuestSmsConsent(
        reservation.externalRaw
      )
    ) {
      log(
        "Pre-checkin SMS skipped",
        {
          reservationNumber:
            reservation.reservationNumber ??
            null,
          reservationId:
            reservation.id,
          reason:
            "SMS_CONSENT_NOT_GRANTED",
        }
      );

      continue;
    }

    try {
      await sendPreCheckinSms(
        prisma,
        reservation.id
      );
    } catch (error) {
      errLog(
        "Pre-checkin crashed",
        {
          reservationNumber:
            reservation.reservationNumber ??
            null,
          reservationId:
            reservation.id,
          error:
            toErrString(error),
        }
      );
    }
  }
}

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

function hasGuestSmsConsent(
  externalRaw: unknown
): boolean {
  if (
    !externalRaw ||
    typeof externalRaw !== "object" ||
    Array.isArray(externalRaw)
  ) {
    return false;
  }

  const consent = (
    externalRaw as Record<string, unknown>
  ).consent;

  if (
    !consent ||
    typeof consent !== "object" ||
    Array.isArray(consent)
  ) {
    return false;
  }

  const consentRecord =
    consent as Record<string, unknown>;

  const acceptedAt = String(
    consentRecord.acceptedAt ?? ""
  ).trim();

  return (
    consentRecord.smsConsent === true &&
    acceptedAt.length > 0
  );
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
  const provisionThrough = new Date(
    now.getTime() + 2 * 60 * 60 * 1000
  );

  return prisma.reservation.findMany({
    where: {
      status: ReservationStatus.ACTIVE,
      paymentState: PaymentState.PAID,
      checkIn: {
        lte: provisionThrough,
      },
      checkOut: {
        gt: now,
      },
      accessGrants: {
        some: {
          type: AccessGrantType.GUEST,
          method:
            AccessMethod.PASSCODE_TIMEBOUND,
          status: AccessStatus.PENDING,
          startsAt: {
            lte: provisionThrough,
          },
          endsAt: {
            gt: now,
          },
        },
        none: {
          type: AccessGrantType.GUEST,
          status: AccessStatus.ACTIVE,
          endsAt: {
            gt: now,
          },
        },
      },
    },
    take: BATCH_SIZE,
    orderBy: {
      checkIn: "asc",
    },
    include: {
           property: {
        select: {
          organizationId: true,
          name: true,
          timezone: true,
        },
      },
      accessGrants: {
        where: {
          type: AccessGrantType.GUEST,
          method:
            AccessMethod.PASSCODE_TIMEBOUND,
          status: AccessStatus.PENDING,
          startsAt: {
            lte: provisionThrough,
          },
          endsAt: {
            gt: now,
          },
        },
        orderBy: {
          startsAt: "asc",
        },
        take: 5,
        include: {
          lock: true,
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

async function processGuestAccessReleaseRepairs(
  now: Date
) {
  const grants =
    await prisma.accessGrant.findMany({
      where: {
        type: AccessGrantType.GUEST,
        method:
          AccessMethod.PASSCODE_TIMEBOUND,
        status: AccessStatus.ACTIVE,
        ttlockKeyboardPwdId: {
          not: null,
        },
        secureAccessCode: {
          isNot: null,
        },
        reservation: {
          is: {
            status:
              ReservationStatus.ACTIVE,
            checkOut: {
              gt: now,
            },
            guestJourney: {
              is: {
                currentState: {
                  in: [
                    GuestJourneyState
                      .VERIFICATION_COMPLETED,
                    GuestJourneyState
                      .ACCESS_SCHEDULED,
                    GuestJourneyState
                      .READY_FOR_ARRIVAL,
                  ],
                },
              },
            },
          },
        },
        OR: [
          {
            reservation: {
              is: {
                guestAccessReleaseStatus: {
                  not:
                    GuestAccessReleaseStatus
                      .RELEASED,
                },
              },
            },
          },
          {
            reservation: {
              is: {
                guestAccessReleasedAt:
                  null,
              },
            },
          },
          {
            reservation: {
              is: {
                guestJourney: {
                  is: {
                    currentState:
                      GuestJourneyState
                        .VERIFICATION_COMPLETED,
                  },
                },
              },
            },
          },
        ],
      },
      take: BATCH_SIZE,
      orderBy: {
        lastAppliedAt: "asc",
      },
      select: {
        id: true,
        reservationId: true,
        lastAppliedAt: true,
        reservation: {
          select: {
            id: true,
            reservationNumber: true,
            guestAccessReleasedAt: true,
          },
        },
      },
    });

  if (grants.length === 0) {
    return;
  }

  log(
    "Guest access release repairs found",
    {
      count: grants.length,
    }
  );

  for (const grant of grants) {
    if (
      !grant.reservationId ||
      !grant.reservation
    ) {
      continue;
    }

    try {
      const accessReleasedAt =
        grant.reservation
          .guestAccessReleasedAt ??
        grant.lastAppliedAt ??
        now;

      const guestJourneyResult =
        await prisma.$transaction(
          async (tx) => {
            await tx.reservation.update({
              where: {
                id: grant.reservation!.id,
              },
              data: {
                guestAccessReleaseStatus:
                  GuestAccessReleaseStatus
                    .RELEASED,
                guestAccessReleasedAt:
                  accessReleasedAt,
                guestAccessReleaseLastError:
                  null,
              },
            });

            return scheduleGuestJourneyAccess(
              tx,
              grant.reservation!.id,
              grant.id
            );
          }
        );

      await prisma.accessGrant.update({
        where: {
          id: grant.id,
        },
        data: {
          lastError: null,
        },
      });

      log(
        "Guest access release repaired",
        {
          reservationNumber:
            grant.reservation
              .reservationNumber ?? null,
          reservationId:
            grant.reservation.id,
          accessGrantId: grant.id,
          guestJourneyState:
            guestJourneyResult.currentState,
          guestJourneyTransitioned:
            guestJourneyResult.transitioned,
        }
      );
    } catch (error) {
      const message =
        toErrString(error);

      await prisma.accessGrant
        .update({
          where: {
            id: grant.id,
          },
          data: {
            lastError:
              `GUEST_ACCESS_RELEASE_REPAIR_FAILED:${message}`,
          },
        })
        .catch(() => {});

      errLog(
        "Guest access release repair FAILED",
        {
          reservationNumber:
            grant.reservation
              .reservationNumber ?? null,
          reservationId:
            grant.reservation.id,
          accessGrantId: grant.id,
          error: message,
        }
      );
    }
  }
}

async function processCheckins(now: Date) {
  const reservations =
    await fetchDueCheckins(now);

  log("processCheckins result", {
    count: reservations.length,
  });

  if (reservations.length === 0) return;

  for (const reservation of reservations) {
    for (const grant of reservation.accessGrants) {
      if (
        grant.type !== AccessGrantType.GUEST ||
        grant.method !==
          AccessMethod.PASSCODE_TIMEBOUND
      ) {
        continue;
      }

      try {
        const organizationId =
          reservation.property?.organizationId;

        if (!organizationId) {
          await prisma.accessGrant.update({
            where: {
              id: grant.id,
            },
            data: {
              status: AccessStatus.FAILED,
              lastError:
                "Missing reservation.property.organizationId",
            },
          });

          continue;
        }

        // Billing siempre antes de TTLock.
        const entitled =
          await isOrgEntitled(
            organizationId,
            now
          );

        if (!entitled.ok) {
          await prisma.accessGrant.update({
            where: {
              id: grant.id,
            },
            data: {
              status: AccessStatus.SUSPENDED,
              lastError: `Blocked by billing: ${entitled.reason}`,
            },
          });

          continue;
        }

        // Confirma que el grant todavía está PENDING.
        const claimed =
          await prisma.accessGrant.updateMany({
            where: {
              id: grant.id,
              status: AccessStatus.PENDING,
            },
            data: {
              lastError: null,
            },
          });

        if (claimed.count === 0) {
          continue;
        }

        // TTLock Brain crea únicamente PASSCODE PERIOD/TIMED.
        const activation =
          await activateGrant(grant.id);

        if (
          (activation as any)?.ok !== true
        ) {
          throw new Error(
            `GUEST_PASSCODE_ACTIVATION_FAILED:${
              (activation as any)?.reason ??
              "UNKNOWN"
            }`
          );
        }

        const passcodePlain =
          (activation as any)
            ?.passcodePlain ?? null;

        const accessReleasedAt = new Date();

        const guestJourneyAccessResult =
          await prisma.$transaction(async (tx) => {
            await tx.reservation.update({
              where: {
                id: reservation.id,
              },
              data: {
                guestAccessReleaseStatus:
                  "RELEASED",
                guestAccessReleasedAt:
                  accessReleasedAt,
                guestAccessReleaseLastError:
                  null,
              },
            });

            return scheduleGuestJourneyAccess(
              tx,
              reservation.id,
              grant.id
            );
          });
        
        const guestJourneyReadyResult =
          await prisma.$transaction(
            async (tx) =>
              markGuestJourneyReadyForArrival(
                tx,
                reservation.id,
                grant.id,
                accessReleasedAt
              )
          );

        log("Guest passcode activated", {
          reservationNumber:
            reservation.reservationNumber ??  
              null, 
          reservationId: reservation.id,
          accessGrantId: grant.id,
          method:
            AccessMethod.PASSCODE_TIMEBOUND,
          startsAt:
            grant.startsAt.toISOString(),
          endsAt:
            grant.endsAt.toISOString(),
          guestJourneyState:
            guestJourneyAccessResult.currentState,
          guestJourneyTransitioned:
            guestJourneyAccessResult.transitioned,
          readyForArrivalState:
            guestJourneyReadyResult.currentState,
          readyForArrivalTransitioned:
            guestJourneyReadyResult.transitioned,
        });

        // NFC es complementario y solamente aplica
        // cuando el host eligió PASSCODE_PLUS_NFC.
        if (
          reservation.guestAccessModeSnapshot ===
          "PASSCODE_PLUS_NFC"
        ) {
          try {
            const existingAssignments =
              await prisma.nfcAssignment.findMany({
                where: {
                  reservationId:
                    reservation.id,
                  role:
                    NfcAssignmentRole.GUEST,
                  status: {
                    in: [
                      NfcAssignmentStatus.SCHEDULED,
                      NfcAssignmentStatus.PROVISIONING,
                      NfcAssignmentStatus.ACTIVE,
                      NfcAssignmentStatus.FAILED,
                    ],
                  },
                },
                select: {
                  id: true,
                },
              });

            const guestCardCount = 2;
            const cardsNeeded = Math.max(
              guestCardCount -
                existingAssignments.length,
              0
            );

            if (cardsNeeded > 0) {
              await assignNfcCards(prisma, {
                reservationId:
                  reservation.id,
                ttlockLockId: Number(
                  grant.lock.ttlockLockId
                ),
                propertyId:
                  reservation.propertyId,
                role:
                  NfcAssignmentRole.GUEST,
                startsAt: grant.startsAt,
                endsAt: grant.endsAt,
                count: cardsNeeded,
                skipTtlock: true,
              });
            }

            log("Guest NFC scheduled", {
              reservationNumber:
                reservation.reservationNumber ??
                null,
              reservationId:
                reservation.id,
              requiredCards: guestCardCount,
              existingCards:
                existingAssignments.length,
              scheduledCards: cardsNeeded,
            });
          } catch (error) {
            errLog(
              "Guest NFC scheduling FAILED",
              {
                reservationNumber:
                  reservation.reservationNumber ??
                  null,
                reservationId:
                  reservation.id,
                accessGrantId: grant.id,
                error:
                  toErrString(error),
              }
            );
          }
        }

        const reservationNumber =
          reservation.reservationNumber ??
          "Pending";
        const guestLanguage = resolveGuestLanguage(
          reservation.preferredLanguage
        );

        const emailSubject =
          `${guestLanguage === "es" ? "Su acceso Pin&Go está listo - Reservación" : "Your Pin&Go access is ready - Reservation"} #${reservationNumber}`;

        const guestReplyTo =
          await resolveOrganizationGuestReplyTo(
            prisma,
            reservation.property.organizationId
          );

        const emailDeliveryResult =
          await sendLoggedEmail({
            prisma,
            type: "GUEST_ACCESS_PASSCODE",
            to: reservation.guestEmail,
            subject: emailSubject,
            reservationId: reservation.id,
            propertyId:
              reservation.propertyId,
            organizationId:
              reservation.property.organizationId,

            // No guardar el passcode en logs.
            retryPayload: {
              reservationNumber,
              accessGrantId: grant.id,
              validFrom:
                grant.startsAt.toISOString(),
              validUntil:
                grant.endsAt.toISOString(),
              preferredLanguage:
                guestLanguage,
            },

            send: async () => {
              if (!passcodePlain) {
                throw new Error(
                  "GUEST_PASSCODE_MISSING_FOR_EMAIL"
                );
              }

              return sendGuestAccessPasscodeEmail({
                to: String(
                  reservation.guestEmail ?? ""
                ),
                replyTo: guestReplyTo.email,
                reservationNumber,
                guestName:
                  reservation.guestName,
                propertyName:
                  reservation.property.name,
                passcode:
                  String(passcodePlain),
                unlockKey:
                  grant.unlockKey ?? "#",
                validFrom:
                  grant.startsAt,
                validUntil:
                  grant.endsAt,
                propertyTimeZone:
                  reservation.property.timezone,
                preferredLanguage:
                  guestLanguage,
              });
            },
          });

        if (emailDeliveryResult.ok) {
          log("Guest access email sent", {
            reservationNumber:
              reservation.reservationNumber ??
              null,
            reservationId:
              reservation.id,
            accessGrantId: grant.id,
          });
        } else {
          const emailError =
            emailDeliveryResult.error ??
            "Guest access email was not delivered";

          errLog(
            "Guest access email FAILED",
            {
              reservationNumber:
                reservation.reservationNumber ??
                null,
              reservationId:
                reservation.id,
              accessGrantId: grant.id,
              status:
                emailDeliveryResult.status,
              error: emailError,
            }
          );

          await prisma.reservation.update({
            where: {
              id: reservation.id,
            },
            data: {
              guestAccessReleaseLastError:
                `EMAIL_DELIVERY_FAILED:${emailError}`,
            },
          });
        }

        const guestSmsConsent =
          hasGuestSmsConsent(
            reservation.externalRaw
          );

                if (
          GUEST_SMS_ENABLED &&
          guestSmsConsent
        ) {
          try {
            const result =
              await sendGuestPasscodeSms({
                prisma,
                reservationId:
                  reservation.id,
                accessGrantId: grant.id,
                guestName:
                  reservation.guestName,
                guestPhone:
                  reservation.guestPhone,
                code: passcodePlain,
                validUntil: grant.endsAt,
              });

            if (result.ok) {
              log("Guest SMS sent", {
                reservationNumber:
                  reservation.reservationNumber ??
                  null,
                reservationId:
                  reservation.id,
                accessGrantId: grant.id,
              });
            } else if (result.skipped) {
              log("Guest SMS skipped", {
                reservationNumber:
                  reservation.reservationNumber ??
                  null,
                reason: result.error,
              });
            } else {
              throw new Error(
                result.error ??
                  "Unknown SMS error"
              );
            }
                  } catch (error) {
            errLog("Guest SMS FAILED", {
              reservationNumber:
                reservation.reservationNumber ??
                null,
              reservationId:
                reservation.id,
              accessGrantId: grant.id,
              error: toErrString(error),
            });
          }
        } else {
          log("Guest SMS skipped", {
            reservationNumber:
              reservation.reservationNumber ??
              null,
            reservationId:
              reservation.id,
            accessGrantId: grant.id,
            reason: !GUEST_SMS_ENABLED
              ? "GUEST_SMS_DISABLED"
              : "SMS_CONSENT_NOT_GRANTED",
          });
        }
      } catch (error) {
        const message =
          toErrString(error);

        await prisma.accessGrant.update({
          where: {
            id: grant.id,
          },
          data: {
            lastError: message,
          },
        });

        errLog(
          "Guest activation FAILED",
          {
            reservationNumber:
              reservation.reservationNumber ??
              null,
            reservationId:
              reservation.id,
            accessGrantId: grant.id,
            error: message,
          }
        );
      }
    }
  }
}

async function activateGuestNfcAssignmentsForReservation(params: {
  reservationId: string;
  lockIdTtlock: number;
  startsAt: Date;
  endsAt: Date;
}) {
  const { reservationId, lockIdTtlock, startsAt, endsAt } = params;

  const assigns = await prisma.nfcAssignment.findMany({
    where: {
      reservationId,
      role: "GUEST" as any,
      status: { in: ["ACTIVE", "FAILED", "ENDED"] as any },
    },
    include: { NfcCard: true }, // ✅ OJO: relación se llama NfcCard en tu schema
  });

  let activated = 0;

  for (const a of assigns) {
    const cardId = a.NfcCard?.ttlockCardId;
    if (!cardId) continue;

    try {
      await ttlockChangeCardPeriod({
        lockId: Number(lockIdTtlock),
        cardId: Number(cardId),
        startDate: startsAt.getTime(),
        endDate: endsAt.getTime(),
        changeType: 2, // gateway
      });

      await prisma.$transaction([
        prisma.nfcAssignment.update({
          where: { id: a.id },
          data: { status: NfcAssignmentStatus.ACTIVE, lastError: null },
        }),
        prisma.nfcCard.update({
          where: { id: a.nfcCardId },
          data: { status: NfcCardStatus.ASSIGNED },
        }),
      ]);

      activated++;
    } catch (e) {
      const msg = toErrString(e);
      await prisma.nfcAssignment
        .update({
          where: { id: a.id },
          data: { status: NfcAssignmentStatus.FAILED, lastError: `TTLOCK_ACTIVATE_FAILED: ${msg}` },
        })
        .catch(() => {});
    }
  }

  return { ok: true, activated };
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

try {
  const lock = await prisma.lock.findUnique({ where: { id: grant.lockId } });
  const ttlockLockId = lock?.ttlockLockId;

  if (ttlockLockId) {
    // ✅ SOLO GUEST (NO tocar CLEANING)
    await unassignGuestNfcForReservation(prisma, {
      reservationId: r.id,
      ttlockLockId: Number(ttlockLockId),
    });
  } else {
    // ✅ mínimo: cerrar SOLO GUEST en DB si no tenemos ttlockLockId
    await prisma.nfcAssignment.updateMany({
      where: {
        reservationId: r.id,
        role: NfcAssignmentRole.GUEST,
        status: NfcAssignmentStatus.ACTIVE,
      },
      data: { status: NfcAssignmentStatus.ENDED, lastError: null },
    });

    await prisma.nfcCard.updateMany({
      where: {
        NfcAssignment: {
          some: {
            reservationId: r.id,
            role: NfcAssignmentRole.GUEST,
          },
        },
      },
      data: { status: NfcCardStatus.AVAILABLE },
    });
  }
} catch (e: any) {
  errLog("NFC revoke failed", { reservationId: r.id, err: toErrString(e) });
}

// 2) Limpia error si quedó alguno (opcional, safe)
await prisma.accessGrant.update({
  where: { id: grant.id },
  data: { lastError: null },
});

try {
  await sendCheckoutSms(prisma, r.id);
} catch (e) {
  errLog("Checkout SMS failed", {
    reservationId: r.id,
    err: toErrString(e),
  });
}
      
 try {
  await sendCleaningReadySms(prisma, r.id);
} catch (e) {
  errLog("Cleaning READY SMS failed", {
    reservationId: r.id,
    err: toErrString(e),
  });
}
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

    async function revokeGuestNfcAssignmentsForReservation(params: {
  reservationId: string;
  lockIdTtlock: number;
  now: Date;
}) {
  const { reservationId, lockIdTtlock, now } = params;

  const assigns = await prisma.nfcAssignment.findMany({
    where: {
      reservationId,
      role: NfcAssignmentRole.GUEST,
      status: NfcAssignmentStatus.ACTIVE,
    },
    include: { NfcCard: true }, // ✅ mayúscula (según tu schema)
  });

  let ended = 0;

  for (const a of assigns) {
    const cardId = a.NfcCard?.ttlockCardId;
    if (!cardId) continue;

    try {
      // 1) Revocar en TTLock (vencer periodo)
      await ttlockChangeCardPeriod({
        lockId: Number(lockIdTtlock),
        cardId: Number(cardId),
        startDate: now.getTime(),
        endDate: now.getTime(),
        changeType: 2, // gateway
      });

      // 2) Prisma: ENDED + liberar card AVAILABLE en una sola transacción
      await prisma.$transaction([
        prisma.nfcAssignment.update({
          where: { id: a.id },
          data: { status: NfcAssignmentStatus.ENDED, lastError: null, endsAt: now },
        }),
        prisma.nfcCard.update({
          where: { id: a.nfcCardId },
          data: { status: NfcCardStatus.AVAILABLE },
        }),
      ]);

      ended++;
    } catch (e: any) {
      const msg = String(e?.message ?? e);

      // ⚠️ Si TTLock falló, NO liberamos tarjeta (seguridad)
      await prisma.nfcAssignment.update({
        where: { id: a.id },
        data: { lastError: `TTLOCK_REVOKE_FAILED: ${msg}` },
      });
    }
  }

  return { ok: true, count: ended };
}

// ---- Cleaning processors ----

async function processCleaningActivations(now: Date) {
  const assignments =
    await fetchDueCleaningAssignments(now);

  log("processCleaningActivations result", {
    count: assignments.length,
  });

  if (assignments.length === 0) return;

  for (const assignment of assignments) {
    try {
      const activeCleaningNfc =
        await prisma.nfcAssignment.findFirst({
          where: {
            reservationId:
              assignment.reservationId,
            role: NfcAssignmentRole.CLEANING,
            status: NfcAssignmentStatus.ACTIVE,
            startsAt: {
              lte: now,
            },
            endsAt: {
              gt: now,
            },
          },
          include: {
            NfcCard: true,
          },
          orderBy: {
            createdAt: "desc",
          },
        });

      if (!activeCleaningNfc) {
        const latestCleaningNfc =
          await prisma.nfcAssignment.findFirst({
            where: {
              reservationId:
                assignment.reservationId,
              role: NfcAssignmentRole.CLEANING,
            },
            select: {
              status: true,
              lastError: true,
              retryCount: true,
            },
            orderBy: {
              createdAt: "desc",
            },
          });

        throw new Error(
          latestCleaningNfc
            ? `CLEANING_NFC_NOT_ACTIVE:status=${latestCleaningNfc.status};retryCount=${latestCleaningNfc.retryCount};error=${latestCleaningNfc.lastError ?? "none"}`
            : "CLEANING_NFC_ASSIGNMENT_NOT_FOUND"
        );
      }

      const claimed =
        await prisma.staffAssignment.updateMany({
          where: {
            id: assignment.id,
            status:
              StaffAssignmentStatus.SCHEDULED,
          },
          data: {
            status: StaffAssignmentStatus.ACTIVE,
            lastError: null,
          },
        });

      if (claimed.count === 0) {
        continue;
      }

      const grant =
        await ensureStaffGrantForAssignment(
          assignment
        );

      const activatedGrant =
        await prisma.accessGrant.updateMany({
          where: {
            id: grant.id,
            status: AccessStatus.PENDING,
          },
          data: {
            status: AccessStatus.ACTIVE,
            ttlockRefId: String(
              activeCleaningNfc.NfcCard
                .ttlockCardId
            ),
            lastError: null,
          },
        });

      if (activatedGrant.count === 0) {
        const currentGrant =
          await prisma.accessGrant.findUnique({
            where: {
              id: grant.id,
            },
            select: {
              status: true,
            },
          });

        if (
          currentGrant?.status !==
          AccessStatus.ACTIVE
        ) {
          throw new Error(
            `CLEANING_ACCESS_GRANT_NOT_ACTIVATABLE:${currentGrant?.status ?? "NOT_FOUND"}`
          );
        }
      }

      if (CLEANING_SMS_ENABLED) {
        try {
          const result =
            await sendCleaningStartSms({
              prisma,
              accessGrantId: grant.id,
              phoneE164:
                assignment.staffMember?.phoneE164,
              staffName:
                assignment.staffMember?.fullName,
              propertyName:
                assignment.reservation?.property
                  ?.name,
              roomName:
                assignment.reservation?.roomName,
              startsAt: assignment.startsAt,
              endsAt: assignment.endsAt,
              timezone:
                assignment.reservation?.property
                  ?.timezone,
          });

          if (result.ok) {
            log("Cleaning SMS sent (START)", {
              assignmentId: assignment.id,
            });
          } else if (result.skipped) {
            log("Cleaning SMS skipped (START)", {
              assignmentId: assignment.id,
              reason: result.error,
            });
          } else {
            throw new Error(
              result.error ??
                "Unknown SMS error"
            );
          }
        } catch (error) {
          errLog(
            `Cleaning SMS START FAILED assignment ${assignment.id} -> ${toErrString(error)}`
          );
        }
      }

      log("Cleaning assignment ACTIVE", {
        reservationNumber:
          assignment.reservation
            ?.reservationNumber ?? null,
        reservationId:
          assignment.reservationId,
        staffAssignmentId: assignment.id,
        accessGrantId: grant.id,
        nfcAssignmentId:
          activeCleaningNfc.id,
        nfcCardLabel:
          activeCleaningNfc.NfcCard?.label ??
          null,
      });
    } catch (error) {
      const message = toErrString(error);

      await prisma.staffAssignment.update({
        where: {
          id: assignment.id,
        },
        data: {
          status: StaffAssignmentStatus.FAILED,
          lastError: message,
          retryCount: {
            increment: 1,
          },
        },
      });

      errLog("Cleaning activation FAILED", {
        reservationNumber:
          assignment.reservation
            ?.reservationNumber ?? null,
        reservationId:
          assignment.reservationId,
        staffAssignmentId: assignment.id,
        error: message,
      });
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

     if (CLEANING_SMS_ENABLED) {
  try {
    const result = await sendCleaningEndSms({
      prisma,
      accessGrantId: a.accessGrantId ?? null,
      phoneE164: a.staffMember?.phoneE164,
      staffName: a.staffMember?.fullName,
      propertyName: a.reservation?.property?.name,
      roomName: a.reservation?.roomName,
      endsAt: a.endsAt,
      timezone: a.reservation?.property?.timezone,
   });

    if (result.ok) {
      log(`Cleaning SMS sent (END)`, { assignmentId: a.id });
    } else if (result.skipped) {
      log(`Cleaning SMS skipped (END)`, {
        assignmentId: a.id,
        reason: result.error,
      });
    } else {
      throw new Error(result.error ?? "Unknown SMS error");
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

async function processPasscodeResyncs(now: Date) {
  const grants = await prisma.accessGrant.findMany({
    where: {
      type: AccessGrantType.GUEST,
      method: AccessMethod.PASSCODE_TIMEBOUND,

      status: {
        in: [AccessStatus.ACTIVE, AccessStatus.PENDING],
      },

      ttlockKeyboardPwdId: {
        not: null,
      },

      reservation: {
        status: "ACTIVE",
      },
    },

    include: {
      reservation: true,
      lock: true,
    },

    take: 50,
  });

  if (grants.length === 0) return;

  for (const g of grants) {
    try {
      const desiredStart = new Date(
        g.reservation.checkIn
      );

      const desiredEnd = new Date(
        g.reservation.checkOut
      );

const lastAppliedStart = g.desiredStartsAt;
const lastAppliedEnd = g.desiredEndsAt;

const grantAlreadyMatchesReservation =
  g.startsAt.getTime() === desiredStart.getTime() &&
  g.endsAt.getTime() === desiredEnd.getTime();

if (!lastAppliedStart || !lastAppliedEnd) {
  if (grantAlreadyMatchesReservation) {
    await prisma.accessGrant.update({
      where: { id: g.id },
      data: {
        desiredStartsAt: desiredStart,
        desiredEndsAt: desiredEnd,
        lastAppliedAt: new Date(),
        lastError: null,
      },
    });

    console.log("[PASSCODE_RESYNC][BASELINE_SET]", {
      grantId: g.id,
      keyboardPwdId: g.ttlockKeyboardPwdId,
    });

    continue;
  }
}

const needsUpdate =
  !lastAppliedStart ||
  !lastAppliedEnd ||
  lastAppliedStart.getTime() !== desiredStart.getTime() ||
  lastAppliedEnd.getTime() !== desiredEnd.getTime();

if (!needsUpdate) continue;
      const lock = await prisma.lock.findUnique({
  where: {
    id: g.lockId,
  },
  select: {
    ttlockLockId: true,
  },
});

const ttlockLockId = lock?.ttlockLockId;

if (!ttlockLockId) {
  console.log("[PASSCODE_RESYNC][NO_LOCK]", {
    grantId: g.id,
    lockId: g.lockId,
  });

  continue;
}

      console.log(
        "[PASSCODE_RESYNC][RUN]",
        {
          grantId: g.id,
          keyboardPwdId:
            g.ttlockKeyboardPwdId,
          oldStart:
            g.startsAt.toISOString(),
          oldEnd:
            g.endsAt.toISOString(),
          newStart:
            desiredStart.toISOString(),
          newEnd:
            desiredEnd.toISOString(),
        }
      );
   
      await ttlockChangePasscode({
        lockId: Number(ttlockLockId),
        keyboardPwdId: Number(
          g.ttlockKeyboardPwdId
        ),
        startDate:
           desiredStart.getTime(),
        endDate:
           desiredEnd.getTime(),
      });

     await prisma.accessGrant.update({
  where: { id: g.id },
  data: {
    desiredStartsAt: desiredStart,
    desiredEndsAt: desiredEnd,
    lastAppliedAt: new Date(),
    lastError: null,
  },
});
      console.log(
        "[PASSCODE_RESYNC][OK]",
        {
          grantId: g.id,
        }
      );
    } catch (e: any) {
      const msg = toErrString(e);

      console.error(
        "[PASSCODE_RESYNC][FAILED]",
        {
          grantId: g.id,
          err: msg,
        }
      );

      await prisma.accessGrant.update({
        where: { id: g.id },

        data: {
          lastError: msg,
        },
      });
    }
  }
}

// ====== LOOP ======
let shuttingDown = false;
let tickRunning = false;

async function tick() {
  if (shuttingDown) return;

  if (tickRunning) {
    log("Tick skipped because the previous cycle is still running");
    return;
  }

  tickRunning = true;

  try {
    const now = new Date();

    log("tick", {
      now: now.toISOString(),
    });

    try {
      await processPasscodeResyncs(now);
    } catch (e) {
      errLog(
        "processPasscodeResyncs crashed:",
        toErrString(e)
      );
    }

     try {
      await processGuestAccessReleaseRepairs(
        now
      );
    } catch (e) {
      errLog(
        "processGuestAccessReleaseRepairs crashed:",
        toErrString(e)
      );
    }

    try {
      await processCheckins(now);
      await processPreCheckinMessages(now);
    } catch (e) {
      errLog(
        "runCheckins crashed:",
        toErrString(e)
      );
    }
    try {
      const result = await retryPendingNfcSync(
        prisma,
        now
      );

      if (
        result.scheduled > 0 ||
        result.retried > 0 ||
        result.activated > 0 ||
        result.failed > 0
      ) {
        log("nfc-provisioning", result);
      }
    } catch (e) {
      errLog(
        "nfc-provisioning crashed:",
        toErrString(e)
      );
    }

    try {
      await processGuestLinkReminders(now);
    } catch (e) {
      errLog(
        "runGuestLinkReminders crashed:",
        toErrString(e)
      );
    }

        try {
          await processGuestVerificationReminders(
            now
          );
        } catch (e) {
          errLog(
            "processGuestVerificationReminders crashed:",
            toErrString(e)
          );
        }

    try {
      await processCheckouts(now);
    } catch (e) {
      errLog(
        "runCheckouts crashed:",
        toErrString(e)
      );
    }

    try {
      const result = await expireGuestNfcAssignments(
        prisma,
        now
      );

      if (result.count > 0) {
        log(
          "processGuestEnds (NFC) result",
          result
        );
      }
    } catch (e) {
      errLog(
        "processGuestEnds (NFC) crashed",
        {
          err: toErrString(e),
        }
      );
    }

    try {
      const result =
        await expireCleaningNfcAssignments(
          prisma,
          now
        );

      if (result.count > 0) {
        log(
          "processCleaningEnds (NFC) result",
          result
        );
      }
    } catch (e) {
      errLog(
        "processCleaningEnds (NFC) crashed",
        {
          err: toErrString(e),
        }
      );
    }

    try {
      const result =
        await processPendingCleaningConfirmations(
          prisma,
          now
        );

      if (result.sent > 0) {
        log(
          "processPendingCleaningConfirmations result",
          result
        );
      }
    } catch (e) {
      errLog(
        "processPendingCleaningConfirmations crashed",
        {
          err: toErrString(e),
        }
      );
    }

    // Limpieza (STAFF) corre en su propio carril.
    try {
      await processCleaningActivations(now);
    } catch (e) {
      errLog(
        "runCleaningActivations crashed:",
        toErrString(e)
      );
    }

    try {
      await processCleaningEnds(now);
    } catch (e) {
      errLog(
        "runCleaningEnds crashed:",
        toErrString(e)
      );
    }
  } finally {
    tickRunning = false;
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
   
  
 
