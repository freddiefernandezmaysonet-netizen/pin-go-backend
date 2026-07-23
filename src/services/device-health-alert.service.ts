import {
  DashboardUserRole,
  PrismaClient,
} from "@prisma/client";

import {
  sendDeviceGatewayCriticalAlertEmail,
} from "../lib/mailer";

import {
  upsertOperationalIssue,
} from "../apms/operational-intelligence.service";

const ALERT_STATUS = {
  PROCESSING: "PROCESSING",
  SENT: "SENT",
  FAILED: "FAILED",
} as const;

const ALERT_PROCESSING_LEASE_MS =
  15 * 60 * 1000;

const ALERT_RETRY_DELAY_MS =
  60 * 60 * 1000;

const MAX_ALERT_ATTEMPTS = 3;

const MAX_ERROR_LENGTH = 8_000;

function normalizeError(error: unknown): string {
  const message =
    error instanceof Error
      ? error.stack || error.message
      : String(error);

  return message.slice(0, MAX_ERROR_LENGTH);
}

function buildOperationalKey(input: {
  lockId: string;
  reservationId: string;
}) {
  return [
    "DEVICE_GATEWAY_READINESS",
    input.lockId,
    input.reservationId,
  ].join(":");
}

function buildMessageLogMarker(input: {
  lockId: string;
  reservationId: string;
}) {
  return [
    "DEVICE_GATEWAY_CRITICAL_ALERT",
    input.lockId,
    input.reservationId,
  ].join(":");
}

async function resolveHostRecipients(input: {
  prisma: PrismaClient;
  organizationId: string;
}) {
  const orgAdmins =
    await input.prisma.dashboardUser.findMany({
      where: {
        organizationId: input.organizationId,
        isActive: true,
        role: DashboardUserRole.ORG_ADMIN,
      },
      select: {
        email: true,
      },
      orderBy: {
        createdAt: "asc",
      },
    });

  const primaryRecipients = orgAdmins
    .map((user) =>
      String(user.email ?? "")
        .trim()
        .toLowerCase()
    )
    .filter(Boolean);

  if (primaryRecipients.length > 0) {
    return Array.from(
      new Set(primaryRecipients)
    );
  }

  const admins =
    await input.prisma.dashboardUser.findMany({
      where: {
        organizationId: input.organizationId,
        isActive: true,
        role: DashboardUserRole.ADMIN,
      },
      select: {
        email: true,
      },
      orderBy: {
        createdAt: "asc",
      },
    });

  return Array.from(
    new Set(
      admins
        .map((user) =>
          String(user.email ?? "")
            .trim()
            .toLowerCase()
        )
        .filter(Boolean)
    )
  );
}

async function upsertGatewayCriticalIssue(input: {
  prisma: PrismaClient;
  organizationId: string;
  propertyId: string;
  reservationId: string;
  reservationNumber?: string | null;
  lockId: string;
  lockName: string;
  propertyName: string;
  checkIn: Date;
  recipients: string[];
  emailStatus: string;
  emailError?: string | null;
  occurredAt: Date;
}) {
  return upsertOperationalIssue(
    input.prisma,
    {
      operationalKey:
        buildOperationalKey({
          lockId: input.lockId,
          reservationId:
            input.reservationId,
        }),

      issueCode:
        "DEVICE_GATEWAY_OFFLINE_CRITICAL",

      title:
        "Gateway offline before guest check-in",

      issue:
        `The gateway for ${input.propertyName} remains offline less than six hours before check-in.`,

      operationalImpact:
        "Pin&Go may be unable to create, update, or revoke remote guest access.",

      recommendedAction:
        "Restore gateway connectivity immediately before guest arrival.",

      nextAutomaticStep:
        "Pin&Go will continue checking gateway connectivity every hour.",

      engine: "ACCESS",

      severity: "CRITICAL",
      workflowState:
        "ACTION_REQUIRED",
      visibility: "HOST",
      responsibleActor: "HOST",

      actionRequired: true,

      canAutoResolve: true,
      autoResolveStatus: "AVAILABLE",
      autoResolveActionCode:
        "RECHECK_DEVICE_GATEWAY",

      organizationId:
        input.organizationId,
      propertyId: input.propertyId,
      reservationId:
        input.reservationId,
      reservationNumber:
        input.reservationNumber ?? null,

      sourceType: "WORKER",

      actionTarget: "ACCESS",

      metadata: {
        lockId: input.lockId,
        lockName: input.lockName,
        propertyName:
          input.propertyName,
        checkIn:
          input.checkIn.toISOString(),
        recipients:
          input.recipients,
        emailStatus:
          input.emailStatus,
        emailError:
          input.emailError ?? null,
      },

      transitionCode:
        "DEVICE_GATEWAY_CRITICAL_DETECTED",

      transitionSummary:
        "Gateway remained offline inside the six-hour critical check-in window.",

      transitionedBy: "PIN_GO",
      occurredAt: input.occurredAt,
      lastSignalAt: input.occurredAt,
    }
  );
}

export async function markGatewayReadinessWaiting(
  input: {
    prisma: PrismaClient;
    organizationId: string;
    propertyId: string;
    reservationId: string;
    reservationNumber?: string | null;
    lockId: string;
    lockName: string;
    propertyName: string;
    checkIn: Date;
    nextCheckAt: Date;
    occurredAt?: Date;
  }
) {
  const occurredAt =
    input.occurredAt ?? new Date();

  return upsertOperationalIssue(
    input.prisma,
    {
      operationalKey:
        buildOperationalKey({
          lockId: input.lockId,
          reservationId:
            input.reservationId,
        }),

      issueCode:
        "DEVICE_GATEWAY_OFFLINE_RECHECK_SCHEDULED",

      title:
        "Gateway connectivity is being monitored",

      issue:
        `Pin&Go detected that the gateway for ${input.propertyName} is unavailable.`,

      operationalImpact:
        "Remote access readiness may be affected if connectivity is not restored.",

      recommendedAction: null,

      nextAutomaticStep:
        `Pin&Go will check the gateway again at ${input.nextCheckAt.toISOString()}.`,

      engine: "ACCESS",

      severity: "WARNING",
      workflowState: "WAITING",
      visibility: "SYSTEM",
      responsibleActor: "PIN_GO",

      actionRequired: false,

      canAutoResolve: true,
      autoResolveStatus: "AVAILABLE",
      autoResolveActionCode:
        "RECHECK_DEVICE_GATEWAY",

      organizationId:
        input.organizationId,
      propertyId: input.propertyId,
      reservationId:
        input.reservationId,
      reservationNumber:
        input.reservationNumber ?? null,

      sourceType: "WORKER",

      actionTarget: "ACCESS",

      metadata: {
        lockId: input.lockId,
        lockName: input.lockName,
        propertyName:
          input.propertyName,
        checkIn:
          input.checkIn.toISOString(),
        nextCheckAt:
          input.nextCheckAt.toISOString(),
      },

      transitionCode:
        "DEVICE_GATEWAY_RECHECK_SCHEDULED",

      transitionSummary:
        "Pin&Go scheduled another automatic gateway readiness check.",

      transitionedBy: "PIN_GO",
      occurredAt,
      lastSignalAt: occurredAt,
    }
  );
}

export async function resolveGatewayReadinessIssue(
  input: {
    prisma: PrismaClient;
    organizationId: string;
    propertyId: string;
    reservationId: string;
    reservationNumber?: string | null;
    lockId: string;
    lockName: string;
    propertyName: string;
    occurredAt?: Date;
  }
) {
  const occurredAt =
    input.occurredAt ?? new Date();

  return upsertOperationalIssue(
    input.prisma,
    {
      operationalKey:
        buildOperationalKey({
          lockId: input.lockId,
          reservationId:
            input.reservationId,
        }),

      issueCode:
        "DEVICE_GATEWAY_CONNECTIVITY_RESTORED",

      title:
        "Gateway connectivity restored",

      issue:
        `Pin&Go confirmed that the gateway for ${input.propertyName} is connected.`,

      operationalImpact: null,
      recommendedAction: null,
      nextAutomaticStep: null,

      engine: "ACCESS",

      severity: "INFO",
      workflowState: "RESOLVED",
      visibility: "SYSTEM",
      responsibleActor: "NONE",

      actionRequired: false,

      canAutoResolve: true,
      autoResolveStatus: "SUCCEEDED",
      autoResolveActionCode: null,

      organizationId:
        input.organizationId,
      propertyId: input.propertyId,
      reservationId:
        input.reservationId,
      reservationNumber:
        input.reservationNumber ?? null,

      sourceType: "WORKER",

      resolutionCode:
        "DEVICE_GATEWAY_RECOVERED",

      resolutionSummary:
        "Pin&Go automatically confirmed that gateway connectivity was restored.",

      resolutionType: "AUTOMATIC",
      resolvedBy: "PIN_GO",
      resolvedAt: occurredAt,

      actionTarget: "ACCESS",

      metadata: {
        lockId: input.lockId,
        lockName: input.lockName,
        propertyName:
          input.propertyName,
        recoveredAt:
          occurredAt.toISOString(),
      },

      transitionCode:
        "DEVICE_GATEWAY_RECOVERED",

      transitionSummary:
        "Gateway connectivity was restored and the operational issue was resolved automatically.",

      transitionedBy: "PIN_GO",
      occurredAt,
      lastSignalAt: occurredAt,
    }
  );
}

export async function sendGatewayCriticalHostAlert(
  input: {
    prisma: PrismaClient;
    deviceHealthId: string;
    organizationId: string;
    propertyId: string;
    reservationId: string;
    reservationNumber?: string | null;
    lockId: string;
    lockName: string;
    propertyName: string;
    propertyTimeZone?: string | null;
    checkIn: Date;
    now?: Date;
  }
) {
  const now = input.now ?? new Date();

  const logMarker =
    buildMessageLogMarker({
      lockId: input.lockId,
      reservationId:
        input.reservationId,
    });

  /*
   * Reconciliación defensiva:
   *
   * Si Resend entregó el correo y la actualización
   * de DeviceHealth falló después, MessageLog evita
   * que el siguiente tick vuelva a enviarlo.
   */
  const previousSentLog =
    await input.prisma.messageLog.findFirst({
      where: {
        channel: "email",
        provider: "resend",
        status: "SENT",
        reservationId:
          input.reservationId,
        propertyId:
          input.propertyId,
        body: logMarker,
      },
      select: {
        to: true,
        createdAt: true,
      },
      orderBy: {
        createdAt: "desc",
      },
    });

  if (previousSentLog) {
    await input.prisma.deviceHealth.updateMany({
      where: {
        id: input.deviceHealthId,
      },
      data: {
        gatewayCriticalAlertReservationId:
          input.reservationId,
        gatewayCriticalAlertStatus:
          ALERT_STATUS.SENT,
        gatewayCriticalAlertSentAt:
          previousSentLog.createdAt,
        gatewayCriticalAlertRecipients:
          previousSentLog.to
            .split(",")
            .map((email) =>
              email.trim()
            )
            .filter(Boolean),
        gatewayCriticalAlertLastError:
          null,
      },
    });

    return {
      sent: false as const,
      skipped: true as const,
      reason:
        "ALREADY_SENT_RECONCILED" as const,
    };
  }

  const deviceHealth =
    await input.prisma.deviceHealth.findUnique({
      where: {
        id: input.deviceHealthId,
      },
      select: {
        id: true,
        gatewayCriticalAlertReservationId:
          true,
        gatewayCriticalAlertStatus:
          true,
        gatewayCriticalAlertAttemptCount:
          true,
        gatewayCriticalAlertLastAttemptAt:
          true,
        gatewayCriticalAlertSentAt:
          true,
      },
    });

  if (!deviceHealth) {
    throw new Error(
      `DeviceHealth ${input.deviceHealthId} not found`
    );
  }

  const sameReservation =
    deviceHealth
      .gatewayCriticalAlertReservationId ===
    input.reservationId;

  if (
    sameReservation &&
    deviceHealth
      .gatewayCriticalAlertStatus ===
      ALERT_STATUS.SENT
  ) {
    return {
      sent: false as const,
      skipped: true as const,
      reason: "ALREADY_SENT" as const,
    };
  }

  const lastAttemptAt =
    deviceHealth
      .gatewayCriticalAlertLastAttemptAt;

  if (
    sameReservation &&
    deviceHealth
      .gatewayCriticalAlertStatus ===
      ALERT_STATUS.PROCESSING &&
    lastAttemptAt &&
    now.getTime() -
      lastAttemptAt.getTime() <
      ALERT_PROCESSING_LEASE_MS
  ) {
    return {
      sent: false as const,
      skipped: true as const,
      reason:
        "ALERT_ALREADY_PROCESSING" as const,
    };
  }

  if (
    sameReservation &&
    deviceHealth
      .gatewayCriticalAlertStatus ===
      ALERT_STATUS.FAILED &&
    lastAttemptAt &&
    now.getTime() -
      lastAttemptAt.getTime() <
      ALERT_RETRY_DELAY_MS
  ) {
    return {
      sent: false as const,
      skipped: true as const,
      reason:
        "ALERT_RETRY_NOT_DUE" as const,
    };
  }

  const currentAttemptCount =
    sameReservation
      ? deviceHealth
          .gatewayCriticalAlertAttemptCount
      : 0;

  if (
    currentAttemptCount >=
    MAX_ALERT_ATTEMPTS
  ) {
    return {
      sent: false as const,
      skipped: true as const,
      reason:
        "ALERT_ATTEMPTS_EXHAUSTED" as const,
    };
  }

  const attemptCount =
    currentAttemptCount + 1;

  /*
   * Claim atómico.
   *
   * Solo un proceso puede cambiar exactamente
   * este snapshot a PROCESSING.
   */
  const claimed =
    await input.prisma.deviceHealth.updateMany({
      where: {
        id: input.deviceHealthId,

        gatewayCriticalAlertReservationId:
          deviceHealth
            .gatewayCriticalAlertReservationId,

        gatewayCriticalAlertStatus:
          deviceHealth
            .gatewayCriticalAlertStatus,

        gatewayCriticalAlertAttemptCount:
          deviceHealth
            .gatewayCriticalAlertAttemptCount,

        gatewayCriticalAlertLastAttemptAt:
          deviceHealth
            .gatewayCriticalAlertLastAttemptAt,

        gatewayCriticalAlertSentAt:
          deviceHealth
            .gatewayCriticalAlertSentAt,
      },
      data: {
        gatewayCriticalAlertReservationId:
          input.reservationId,
        gatewayCriticalAlertStatus:
          ALERT_STATUS.PROCESSING,
        gatewayCriticalAlertAttemptCount:
          attemptCount,
        gatewayCriticalAlertLastAttemptAt:
          now,
        gatewayCriticalAlertSentAt:
          null,
        gatewayCriticalAlertRecipients:
          undefined,
        gatewayCriticalAlertLastError:
          null,
      },
    });

  if (claimed.count !== 1) {
    return {
      sent: false as const,
      skipped: true as const,
      reason:
        "ALERT_ALREADY_CLAIMED" as const,
    };
  }

  const recipients =
    await resolveHostRecipients({
      prisma: input.prisma,
      organizationId:
        input.organizationId,
    });

  if (recipients.length === 0) {
    const error =
      "No active ORG_ADMIN or ADMIN email recipient is configured.";

    await input.prisma.deviceHealth.updateMany({
      where: {
        id: input.deviceHealthId,
        gatewayCriticalAlertReservationId:
          input.reservationId,
        gatewayCriticalAlertStatus:
          ALERT_STATUS.PROCESSING,
        gatewayCriticalAlertAttemptCount:
          attemptCount,
      },
      data: {
        gatewayCriticalAlertStatus:
          ALERT_STATUS.FAILED,
        gatewayCriticalAlertRecipients:
          [],
        gatewayCriticalAlertLastError:
          error,
      },
    });

    await upsertGatewayCriticalIssue({
      prisma: input.prisma,
      organizationId:
        input.organizationId,
      propertyId: input.propertyId,
      reservationId:
        input.reservationId,
      reservationNumber:
        input.reservationNumber,
      lockId: input.lockId,
      lockName: input.lockName,
      propertyName:
        input.propertyName,
      checkIn: input.checkIn,
      recipients: [],
      emailStatus: "RECIPIENT_MISSING",
      emailError: error,
      occurredAt: now,
    });

    return {
      sent: false as const,
      skipped: false as const,
      reason:
        "RECIPIENT_MISSING" as const,
      attemptCount,
    };
  }

  try {
    const email =
      await sendDeviceGatewayCriticalAlertEmail({
        to: recipients,
        propertyName:
          input.propertyName,
        lockName: input.lockName,
        reservationNumber:
          input.reservationNumber,
        checkIn: input.checkIn,
        propertyTimeZone:
          input.propertyTimeZone,
      });

    const markedSent =
      await input.prisma.deviceHealth.updateMany({
        where: {
          id: input.deviceHealthId,
          gatewayCriticalAlertReservationId:
            input.reservationId,
          gatewayCriticalAlertStatus:
            ALERT_STATUS.PROCESSING,
          gatewayCriticalAlertAttemptCount:
            attemptCount,
        },
        data: {
          gatewayCriticalAlertStatus:
            ALERT_STATUS.SENT,
          gatewayCriticalAlertSentAt:
            new Date(),
          gatewayCriticalAlertRecipients:
            recipients,
          gatewayCriticalAlertLastError:
            null,
        },
      });

    /*
     * Guardamos evidencia incluso si el CAS anterior
     * no aplicó. El próximo tick podrá reconciliar
     * este SENT sin volver a enviar.
     */
    await input.prisma.messageLog.create({
      data: {
        channel: "email",
        to: recipients.join(","),
        from: null,
        body: logMarker,
        provider: "resend",
        providerMessageId:
          email.providerMessageId,
        status: "SENT",
        organizationId:
          input.organizationId,
        propertyId: input.propertyId,
        reservationId:
          input.reservationId,
      },
    });

    await upsertGatewayCriticalIssue({
      prisma: input.prisma,
      organizationId:
        input.organizationId,
      propertyId: input.propertyId,
      reservationId:
        input.reservationId,
      reservationNumber:
        input.reservationNumber,
      lockId: input.lockId,
      lockName: input.lockName,
      propertyName:
        input.propertyName,
      checkIn: input.checkIn,
      recipients,
      emailStatus:
        markedSent.count === 1
          ? "SENT"
          : "SENT_STATE_RECONCILIATION_REQUIRED",
      occurredAt: now,
    });

    return {
      sent: true as const,
      skipped: false as const,
      attemptCount,
      recipients,
      providerMessageId:
        email.providerMessageId,
      stateApplied:
        markedSent.count === 1,
    };
  } catch (error) {
    const normalizedError =
      normalizeError(error);

    await input.prisma.deviceHealth.updateMany({
      where: {
        id: input.deviceHealthId,
        gatewayCriticalAlertReservationId:
          input.reservationId,
        gatewayCriticalAlertStatus:
          ALERT_STATUS.PROCESSING,
        gatewayCriticalAlertAttemptCount:
          attemptCount,
      },
      data: {
        gatewayCriticalAlertStatus:
          ALERT_STATUS.FAILED,
        gatewayCriticalAlertRecipients:
          recipients,
        gatewayCriticalAlertLastError:
          normalizedError,
      },
    });

    try {
      await input.prisma.messageLog.create({
        data: {
          channel: "email",
          to: recipients.join(","),
          from: null,
          body: logMarker,
          provider: "resend",
          providerMessageId: null,
          status: "FAILED",
          error: normalizedError,
          organizationId:
            input.organizationId,
          propertyId:
            input.propertyId,
          reservationId:
            input.reservationId,
        },
      });
    } catch {
      // El error principal sigue persistido
      // en DeviceHealth y Mission Control.
    }

    await upsertGatewayCriticalIssue({
      prisma: input.prisma,
      organizationId:
        input.organizationId,
      propertyId: input.propertyId,
      reservationId:
        input.reservationId,
      reservationNumber:
        input.reservationNumber,
      lockId: input.lockId,
      lockName: input.lockName,
      propertyName:
        input.propertyName,
      checkIn: input.checkIn,
      recipients,
      emailStatus: "FAILED",
      emailError:
        normalizedError,
      occurredAt: now,
    });

    return {
      sent: false as const,
      skipped: false as const,
      reason:
        "EMAIL_DELIVERY_FAILED" as const,
      attemptCount,
      recipients,
      error: normalizedError,
    };
  }
}
