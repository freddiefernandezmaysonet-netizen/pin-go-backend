import { prisma } from "../lib/prisma";
import { computeOperationalRisk } from "../domain/computeOperationalRisk";
import {
  markGatewayReadinessWaiting,
  resolveGatewayReadinessIssue,
  sendGatewayCriticalHostAlert,
  supersedeGatewayReadinessIssue,
} from "../services/device-health-alert.service";
import { upsertDeviceHealth } from "../services/deviceHealth.service";
import {
  TTLockBatteryError,
  ttlockFetchBattery,
} from "../ttlock/ttlock.deviceBattery";
import {
  TTLockGatewayError,
  ttlockFetchGateway,
} from "../ttlock/ttlock.deviceGateway";

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

const BATTERY_MONTHLY_INTERVAL_MS =
  30 * DAY_MS;

const BATTERY_WEEKLY_INTERVAL_MS =
  7 * DAY_MS;

const BATTERY_MONITORING_THRESHOLD =
  30;

const BATTERY_CRITICAL_THRESHOLD =
  20;

const GATEWAY_WINDOW_MS =
  24 * HOUR_MS;

type UpcomingReservation = {
  id: string;
  reservationNumber: string | null;
  propertyId: string;
  checkIn: Date;
};

function getTtlockErrorInfo(error: unknown): {
  errcode: number | null;
  errmsg: string;
} {
  const message =
    error instanceof Error
      ? error.message
      : String(error);

  const errcodeMatch =
    message.match(/errcode=([-\d]+)/);

  const errmsgMatch =
    message.match(/errmsg=(.*)$/);

  return {
    errcode: errcodeMatch
      ? Number(errcodeMatch[1])
      : null,
    errmsg: errmsgMatch
      ? errmsgMatch[1]
      : message,
  };
}

function getLockDisplayName(lock: {
  ttlockLockName: string | null;
  locationLabel: string | null;
}) {
  return (
    lock.locationLabel?.trim() ||
    lock.ttlockLockName?.trim() ||
    "Property lock"
  );
}

function calculateBatteryFailureNextCheckAt(input: {
  now: Date;
  checkIn?: Date | null;
}) {
  /*
   * Sin una reservación operativa dentro de 24 horas,
   * no existe urgencia para repetir la telemetría.
   */
  if (!input.checkIn) {
    return new Date(
      input.now.getTime() + DAY_MS
    );
  }

  const hoursToCheckIn =
    (input.checkIn.getTime() -
      input.now.getTime()) /
    HOUR_MS;

  /*
   * La frecuencia aumenta únicamente cuando existe
   * riesgo operacional para una llegada próxima.
   */
  if (hoursToCheckIn > 12) {
    return new Date(
      input.now.getTime() +
        4 * HOUR_MS
    );
  }

  if (hoursToCheckIn > 6) {
    return new Date(
      input.now.getTime() +
        2 * HOUR_MS
    );
  }

  return new Date(
    input.now.getTime() + HOUR_MS
  );
}

function calculateGatewayNextCheckAt(input: {
  now: Date;
  checkIn: Date;
}) {
  const hoursToCheckIn =
    (input.checkIn.getTime() -
      input.now.getTime()) /
    HOUR_MS;

  if (hoursToCheckIn > 12) {
    return new Date(
      input.checkIn.getTime() -
        12 * HOUR_MS
    );
  }

  if (hoursToCheckIn > 6) {
    return new Date(
      input.checkIn.getTime() -
        6 * HOUR_MS
    );
  }

  return new Date(
    input.now.getTime() + HOUR_MS
  );
}

function isGatewayCheckDue(input: {
  now: Date;
  reservation: UpcomingReservation;
  gatewayConnected: boolean | null;
  gatewayCheckReservationId: string | null;
  gatewayLastSuccessfulAt: Date | null;
  gatewayNextCheckAt: Date | null;
}) {
  const sameReservation =
    input.gatewayCheckReservationId ===
    input.reservation.id;

  const alreadyCertified =
    sameReservation &&
    input.gatewayConnected === true &&
    input.gatewayLastSuccessfulAt !== null;

  if (alreadyCertified) {
    return false;
  }

  if (!sameReservation) {
    return true;
  }

  if (!input.gatewayNextCheckAt) {
    return true;
  }

  return (
    input.gatewayNextCheckAt <= input.now
  );
}

async function closePreviousGatewayWorkflow(input: {
  previousReservationId: string | null;
  currentReservationId: string | null;
  lock: {
    id: string;
    propertyId: string;
    ttlockLockName: string | null;
    locationLabel: string | null;
    property: {
      name: string;
      organizationId: string;
    };
  };
  now: Date;
}) {
  if (
    !input.previousReservationId ||
    input.previousReservationId ===
      input.currentReservationId
  ) {
    return;
  }

  const previousReservation =
    await prisma.reservation.findUnique({
      where: {
        id: input.previousReservationId,
      },
      select: {
        id: true,
        reservationNumber: true,
        status: true,
        checkIn: true,
      },
    });

  if (!previousReservation) {
    return;
  }

  const reason =
    previousReservation.status ===
    "CANCELLED"
      ? "RESERVATION_CANCELLED"
      : previousReservation.checkIn <=
          input.now
        ? "RESERVATION_ENDED"
        : "RESERVATION_REPLACED";

  await supersedeGatewayReadinessIssue({
    prisma,
    organizationId:
      input.lock.property.organizationId,
    propertyId:
      input.lock.propertyId,
    reservationId:
      previousReservation.id,
    reservationNumber:
      previousReservation.reservationNumber,
    lockId:
      input.lock.id,
    lockName:
      getLockDisplayName(input.lock),
    propertyName:
      input.lock.property.name,
    reason,
    occurredAt:
      input.now,
  });
}

export async function runDeviceHealthWorker() {
  const now = new Date();

  const windowEnd =
    new Date(
      now.getTime() +
        GATEWAY_WINDOW_MS
    );

  let batteryCalls = 0;
  let gatewayCalls = 0;
  let criticalEmailsSent = 0;

  console.log(
    "DeviceHealth worker starting",
    {
      startedAt:
        now.toISOString(),
    }
  );

  const upcomingReservations =
    await prisma.reservation.findMany({
      where: {
        status: "ACTIVE",
        checkIn: {
          gte: now,
          lte: windowEnd,
        },
      },
      select: {
        id: true,
        reservationNumber: true,
        propertyId: true,
        checkIn: true,
      },
      orderBy: {
        checkIn: "asc",
      },
    });

  const nextReservationByProperty =
    new Map<
      string,
      UpcomingReservation
    >();

  for (
    const reservation of
    upcomingReservations
  ) {
    if (
      !nextReservationByProperty.has(
        reservation.propertyId
      )
    ) {
      nextReservationByProperty.set(
        reservation.propertyId,
        reservation
      );
    }
  }

  const locks =
    await prisma.lock.findMany({
      where: {
        isActive: true,
      },
      select: {
        id: true,
        propertyId: true,
        ttlockLockId: true,
        ttlockLockName: true,
        locationLabel: true,

        property: {
          select: {
            name: true,
            timezone: true,
            organizationId: true,
          },
        },

        deviceHealth: {
          select: {
            id: true,
            battery: true,
            gatewayConnected: true,
            isOnline: true,
            lastSeenAt: true,

            batteryLastCheckedAt: true,
            batteryNextCheckAt: true,

            gatewayLastCheckedAt: true,
            gatewayLastSuccessfulAt: true,
            gatewayNextCheckAt: true,
            gatewayDisconnectedSince: true,
            gatewayCheckReservationId: true,
          },
        },
      },
    });

  console.log(
    "DeviceHealth active locks loaded",
    {
      activeLocks:
        locks.length,
      reservationsInside24Hours:
        upcomingReservations.length,
    }
  );

  for (const lock of locks) {
    try {
      const reservation =
        nextReservationByProperty.get(
          lock.propertyId
        ) ?? null;

      const existingHealth =
        lock.deviceHealth;

      await closePreviousGatewayWorkflow({
        previousReservationId:
          existingHealth
            ?.gatewayCheckReservationId ??
          null,
        currentReservationId:
          reservation?.id ?? null,
        lock,
        now,
      });

      /*
       * BATTERY SCHEDULER
       *
       * La batería opera con calendario propio.
       * Una comprobación de gateway nunca ejecuta
       * automáticamente una consulta de batería.
       */
      const batteryDue =
        !existingHealth ||
        existingHealth.battery === null ||
        !existingHealth
          .batteryLastCheckedAt ||
        !existingHealth
          .batteryNextCheckAt ||
        existingHealth
          .batteryNextCheckAt <= now;

      if (batteryDue) {
        batteryCalls += 1;

        try {
          const response =
            await ttlockFetchBattery(
              lock.ttlockLockId
            );

          const battery =
            response.battery;

          const nextInterval =
            battery !== null &&
            battery <
              BATTERY_MONITORING_THRESHOLD
              ? BATTERY_WEEKLY_INTERVAL_MS
              : BATTERY_MONTHLY_INTERVAL_MS;

          const batteryNextCheckAt =
            new Date(
              now.getTime() +
                nextInterval
            );

          await upsertDeviceHealth(
            prisma,
            {
              lockId:
                lock.id,
              battery,
              batteryLastCheckedAt:
                now,
              batteryLastSuccessfulAt:
                response.providerResponseAt,
              batteryLastError:
                null,
              batteryRawPayload:
                response.raw,
              batteryProviderResponseAt:
                response.providerResponseAt,
              batteryNextCheckAt,
              lastSyncAt:
                now,
              lastSeenAt:
                now,
              source:
                "WORKER",
              rawPayload: {
                telemetryType:
                  "BATTERY",
                battery:
                  response.raw,
              },
            }
          );

          console.log(
            "DeviceHealth battery checked",
            {
              lockId:
                lock.id,
              battery,
              nextCheckAt:
                batteryNextCheckAt
                  .toISOString(),
            }
          );
        } catch (error) {
          const batteryError =
            error instanceof TTLockBatteryError
              ? error.details
              : null;

          const {
            errcode,
            errmsg,
          } =
            batteryError
              ? {
                  errcode:
                    batteryError.errcode,
                  errmsg:
                    batteryError.message,
                }
              : getTtlockErrorInfo(
                  error
                );

          const batteryNextCheckAt =
            calculateBatteryFailureNextCheckAt({
              now,
              checkIn:
                reservation?.checkIn ??
                null,
            });

          await upsertDeviceHealth(
            prisma,
            {
              lockId:
                lock.id,
              batteryLastCheckedAt:
                now,
              batteryLastFailedAt:
                now,
              batteryLastError:
                errmsg,
              batteryRawPayload:
                batteryError?.rawPayload !== null &&
                batteryError?.rawPayload !== undefined
                  ? batteryError.rawPayload
                  : undefined,
              batteryProviderResponseAt:
                batteryError?.providerResponseAt ??
                undefined,
              batteryNextCheckAt,
              lastSyncAt:
                now,
              source:
                "WORKER",
              rawPayload: {
                telemetryType:
                  "BATTERY",
                ttlockError: {
                  errcode,
                  errmsg,
                  timedOut:
                    batteryError?.timedOut ??
                    false,
                  httpStatus:
                    batteryError?.httpStatus ??
                    null,
                },
              },
            }
          );

          console.warn(
            "DeviceHealth battery check failed",
            {
              lockId:
                lock.id,
              reservationNumber:
                reservation
                  ?.reservationNumber ??
                null,
              errcode,
              errmsg,
              nextCheckAt:
                batteryNextCheckAt
                  .toISOString(),
            }
          );
        }
      }

      /*
       * GATEWAY SCHEDULER
       *
       * Sin reservación ACTIVE dentro de 24 horas:
       * cero llamadas TTLock de gateway.
       */
      if (!reservation) {
        if (
          existingHealth
            ?.gatewayCheckReservationId
        ) {
          await upsertDeviceHealth(
            prisma,
            {
              lockId:
                lock.id,

              gatewayNextCheckAt:
                null,
              gatewayCheckReservationId:
                null,
              gatewayDisconnectedSince:
                null,

              gatewayCriticalAlertReservationId:
                null,
              gatewayCriticalAlertStatus:
                null,
              gatewayCriticalAlertAttemptCount:
                0,
              gatewayCriticalAlertLastAttemptAt:
                null,
              gatewayCriticalAlertSentAt:
                null,
              gatewayCriticalAlertRecipients:
                null,
              gatewayCriticalAlertLastError:
                null,
            }
          );
        }
      } else {
        const gatewayDue =
          isGatewayCheckDue({
            now,
            reservation,
            gatewayConnected:
              existingHealth
                ?.gatewayConnected ??
              null,
            gatewayCheckReservationId:
              existingHealth
                ?.gatewayCheckReservationId ??
              null,
            gatewayLastSuccessfulAt:
              existingHealth
                ?.gatewayLastSuccessfulAt ??
              null,
            gatewayNextCheckAt:
              existingHealth
                ?.gatewayNextCheckAt ??
              null,
          });

        if (gatewayDue) {
          gatewayCalls += 1;

          try {
            const response =
              await ttlockFetchGateway(
                lock.ttlockLockId
              );

            if (response.hasGateway) {
              await upsertDeviceHealth(
                prisma,
                {
                  lockId:
                    lock.id,
                  gatewayConnected:
                    true,
                  gatewayRssi:
                    response.gatewayRssi,
                  isOnline:
                    true,
                  gatewayLastCheckedAt:
                    now,
                  gatewayLastSuccessfulAt:
                    response.providerResponseAt,
                  gatewayLastError:
                    null,
                  gatewayRawPayload:
                    response.raw,
                  gatewayProviderResponseAt:
                    response.providerResponseAt,
                  gatewayNextCheckAt:
                    null,
                  gatewayDisconnectedSince:
                    null,
                  gatewayCheckReservationId:
                    reservation.id,

                  gatewayCriticalAlertReservationId:
                    null,
                  gatewayCriticalAlertStatus:
                    null,
                  gatewayCriticalAlertAttemptCount:
                    0,
                  gatewayCriticalAlertLastAttemptAt:
                    null,
                  gatewayCriticalAlertSentAt:
                    null,
                  gatewayCriticalAlertRecipients:
                    null,
                  gatewayCriticalAlertLastError:
                    null,

                  lastSyncAt:
                    now,
                  lastSeenAt:
                    now,
                  source:
                    "WORKER",
                  rawPayload: {
                    telemetryType:
                      "GATEWAY",
                    gateway:
                      response.raw,
                  },
                }
              );

              await resolveGatewayReadinessIssue(
                {
                  prisma,
                  organizationId:
                    lock.property
                      .organizationId,
                  propertyId:
                    lock.propertyId,
                  reservationId:
                    reservation.id,
                  reservationNumber:
                    reservation
                      .reservationNumber,
                  lockId:
                    lock.id,
                  lockName:
                    getLockDisplayName(
                      lock
                    ),
                  propertyName:
                    lock.property.name,
                  occurredAt:
                    now,
                }
              );

              console.log(
                "DeviceHealth gateway readiness certified",
                {
                  lockId:
                    lock.id,
                  reservationNumber:
                    reservation
                      .reservationNumber,
                }
              );
            } else {
              const nextCheckAt =
                calculateGatewayNextCheckAt(
                  {
                    now,
                    checkIn:
                      reservation.checkIn,
                  }
                );

              await upsertDeviceHealth(
                prisma,
                {
                  lockId:
                    lock.id,
                  gatewayConnected:
                    false,
                  gatewayRssi:
                    response.gatewayRssi,
                  gatewayLastCheckedAt:
                    now,
                  gatewayLastSuccessfulAt:
                    response.providerResponseAt,
                  gatewayLastError:
                    null,
                  gatewayRawPayload:
                    response.raw,
                  gatewayProviderResponseAt:
                    response.providerResponseAt,
                  gatewayNextCheckAt:
                    nextCheckAt,
                  gatewayDisconnectedSince:
                    existingHealth
                      ?.gatewayDisconnectedSince ??
                    now,
                  gatewayCheckReservationId:
                    reservation.id,
                  lastSyncAt:
                    now,
                  source:
                    "WORKER",
                  rawPayload: {
                    telemetryType:
                      "GATEWAY",
                    gateway:
                      response.raw,
                  },
                }
              );

              const hoursToCheckIn =
                (reservation.checkIn.getTime() -
                  now.getTime()) /
                HOUR_MS;

              if (
                hoursToCheckIn <= 6
              ) {
                const deviceHealthId =
                  existingHealth?.id ??
                  (
                    await prisma
                      .deviceHealth
                      .findUniqueOrThrow({
                        where: {
                          lockId:
                            lock.id,
                        },
                        select: {
                          id: true,
                        },
                      })
                  ).id;

                const alert =
                  await sendGatewayCriticalHostAlert(
                    {
                      prisma,
                      deviceHealthId,
                      organizationId:
                        lock.property
                          .organizationId,
                      propertyId:
                        lock.propertyId,
                      reservationId:
                        reservation.id,
                      reservationNumber:
                        reservation
                          .reservationNumber,
                      lockId:
                        lock.id,
                      lockName:
                        getLockDisplayName(
                          lock
                        ),
                      propertyName:
                        lock.property.name,
                      propertyTimeZone:
                        lock.property
                          .timezone,
                      checkIn:
                        reservation.checkIn,
                      now,
                    }
                  );

                if (alert.sent) {
                  criticalEmailsSent += 1;
                }
              } else {
                await markGatewayReadinessWaiting(
                  {
                    prisma,
                    organizationId:
                      lock.property
                        .organizationId,
                    propertyId:
                      lock.propertyId,
                    reservationId:
                      reservation.id,
                    reservationNumber:
                      reservation
                        .reservationNumber,
                    lockId:
                      lock.id,
                    lockName:
                      getLockDisplayName(
                        lock
                      ),
                    propertyName:
                      lock.property.name,
                    checkIn:
                      reservation.checkIn,
                    nextCheckAt,
                    occurredAt:
                      now,
                  }
                );
              }
            }
          } catch (error) {
            const gatewayError =
              error instanceof TTLockGatewayError
                ? error.details
                : null;

            const {
              errcode,
              errmsg,
            } =
              gatewayError
                ? {
                    errcode:
                      gatewayError.errcode,
                    errmsg:
                      gatewayError.message,
                  }
                : getTtlockErrorInfo(
                    error
                  );

            const nextCheckAt =
              calculateGatewayNextCheckAt({
                now,
                checkIn:
                  reservation.checkIn,
              });

            await upsertDeviceHealth(
              prisma,
              {
                lockId:
                  lock.id,
                gatewayConnected:
                  errcode === -2012
                    ? false
                    : null,
                gatewayLastCheckedAt:
                  now,
                gatewayLastFailedAt:
                  now,
                gatewayLastError:
                  errmsg,
                gatewayRawPayload:
                  gatewayError?.rawPayload !== null &&
                  gatewayError?.rawPayload !== undefined
                    ? gatewayError.rawPayload
                    : undefined,
                gatewayProviderResponseAt:
                  gatewayError?.providerResponseAt ??
                  undefined,
                gatewayNextCheckAt:
                  nextCheckAt,
                gatewayDisconnectedSince:
                  existingHealth
                    ?.gatewayDisconnectedSince ??
                  now,
                gatewayCheckReservationId:
                  reservation.id,
                lastSyncAt:
                  now,
                source:
                  "WORKER",
                rawPayload: {
                  telemetryType:
                    "GATEWAY",
                  ttlockError: {
                    errcode,
                    errmsg,
                    timedOut:
                      gatewayError?.timedOut ??
                      false,
                    httpStatus:
                      gatewayError?.httpStatus ??
                      null,
                  },
                },
                ...(
                  errcode === -2018 ||
                  errcode === 1
                    ? {
                        healthOverrideStatus:
                          "UNKNOWN" as const,
                        healthOverrideMessage:
                          "Pin&Go could not validate gateway connectivity.",
                      }
                    : {}
                ),
              }
            );

            const hoursToCheckIn =
              (reservation.checkIn.getTime() -
                now.getTime()) /
              HOUR_MS;

            if (
              hoursToCheckIn <= 6
            ) {
              const currentHealth =
                await prisma.deviceHealth
                  .findUniqueOrThrow({
                    where: {
                      lockId:
                        lock.id,
                    },
                    select: {
                      id: true,
                    },
                  });

              const alert =
                await sendGatewayCriticalHostAlert(
                  {
                    prisma,
                    deviceHealthId:
                      currentHealth.id,
                    organizationId:
                      lock.property
                        .organizationId,
                    propertyId:
                      lock.propertyId,
                    reservationId:
                      reservation.id,
                    reservationNumber:
                      reservation
                        .reservationNumber,
                    lockId:
                      lock.id,
                    lockName:
                      getLockDisplayName(
                        lock
                      ),
                    propertyName:
                      lock.property.name,
                    propertyTimeZone:
                      lock.property
                        .timezone,
                    checkIn:
                      reservation.checkIn,
                    now,
                  }
                );

              if (alert.sent) {
                criticalEmailsSent += 1;
              }
            } else {
              await markGatewayReadinessWaiting(
                {
                  prisma,
                  organizationId:
                    lock.property
                      .organizationId,
                  propertyId:
                    lock.propertyId,
                  reservationId:
                    reservation.id,
                  reservationNumber:
                    reservation
                      .reservationNumber,
                  lockId:
                    lock.id,
                  lockName:
                    getLockDisplayName(
                      lock
                    ),
                  propertyName:
                    lock.property.name,
                  checkIn:
                    reservation.checkIn,
                  nextCheckAt,
                  occurredAt:
                    now,
                }
              );
            }

            console.warn(
              "DeviceHealth gateway check failed",
              {
                lockId:
                  lock.id,
                reservationNumber:
                  reservation
                    .reservationNumber,
                errcode,
                errmsg,
                nextCheckAt:
                  nextCheckAt
                    .toISOString(),
              }
            );
          }
        }
      }

      const latestHealth =
        await prisma.deviceHealth.findUnique({
          where: {
            lockId:
              lock.id,
          },
          select: {
            healthStatus: true,
            battery: true,
            gatewayConnected: true,
            lastSeenAt: true,
          },
        });

      if (!latestHealth) {
        continue;
      }

      const nextCheckInAt =
        reservation?.checkIn ??
        null;

      const risk =
        computeOperationalRisk({
          healthStatus:
            latestHealth
              .healthStatus,
          battery:
            latestHealth
              .battery,
          gatewayConnected:
            latestHealth
              .gatewayConnected,
          lastSeenAt:
            latestHealth
              .lastSeenAt,
          nextCheckInAt,
          hasActiveAccess:
            false,
        });

      if (
        latestHealth
          .gatewayConnected === false &&
        nextCheckInAt
      ) {
        const hoursToCheckIn =
          (nextCheckInAt.getTime() -
            now.getTime()) /
          HOUR_MS;

        if (
          hoursToCheckIn <= 6
        ) {
          risk.operationalRisk =
            "CRITICAL";
          risk.operationalMessage =
            "Gateway unavailable six hours before check-in. Immediate action is required.";
          risk.recommendedAction =
            "Restore gateway connectivity before guest arrival.";
        } else {
          risk.operationalRisk =
            "WARNING";
          risk.operationalMessage =
            "Gateway connectivity is unavailable before an upcoming check-in.";
          risk.recommendedAction =
            "Verify gateway connectivity before guest arrival.";
        }
      }

      if (
        latestHealth.battery !== null &&
        latestHealth.battery <
          BATTERY_CRITICAL_THRESHOLD &&
        nextCheckInAt
      ) {
        risk.operationalRisk =
          "CRITICAL";
        risk.operationalMessage =
          "Battery is below 30% before an upcoming check-in.";
        risk.recommendedAction =
          "Replace the lock batteries before guest arrival.";
      }

      await prisma.deviceHealth.update({
        where: {
          lockId:
            lock.id,
        },
        data: {
          operationalRisk:
            risk.operationalRisk,
          operationalMessage:
            risk.operationalMessage,
          recommendedAction:
            risk.recommendedAction,
          nextCheckInAt,
          hasActiveAccess:
            false,
          riskCalculatedAt:
            now,
        },
      });
    } catch (error) {
      console.error(
        "DeviceHealth worker failed for lock",
        {
          lockId:
            lock.id,
          error:
            error instanceof Error
              ? error.stack ||
                error.message
              : String(error),
        }
      );
    }
  }

  console.log(
    "DeviceHealth worker finished",
    {
      activeLocks:
        locks.length,
      batteryCalls,
      gatewayCalls,
      criticalEmailsSent,
      completedAt:
        new Date().toISOString(),
    }
  );
}