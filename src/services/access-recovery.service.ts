import {
  AccessStatus,
  PrismaClient,
} from "@prisma/client";

import {
  recordAccessRecoveryOperationalFailure,
  resolveAccessRecoveryOperationalIssue,
} from "./access-recovery-operational.service";

export const ACCESS_RECOVERY_OPERATION = {
  REVOKE: "REVOKE",
} as const;

export type AccessRecoveryOperation =
  (typeof ACCESS_RECOVERY_OPERATION)[keyof typeof ACCESS_RECOVERY_OPERATION];

/**
 * Esperas posteriores a cada fallo:
 *
 * intento 1 falla -> 1 minuto
 * intento 2 falla -> 5 minutos
 * intento 3 falla -> 15 minutos
 * intento 4 falla -> 1 hora
 * intento 5 falla -> 3 horas
 * intento 6 falla -> 6 horas
 * intento 7 falla -> recovery agotado
 */
const RETRY_DELAYS_AFTER_FAILURE_MS = [
  60_000,
  5 * 60_000,
  15 * 60_000,
  60 * 60_000,
  3 * 60 * 60_000,
  6 * 60 * 60_000,
] as const;

const MAX_TOTAL_ATTEMPTS =
  RETRY_DELAYS_AFTER_FAILURE_MS.length + 1;

/**
 * Mientras una operación TTLock está ejecutándose,
 * recoveryNextAttemptAt funciona también como lease.
 *
 * Si el worker muere durante la llamada, otro proceso
 * podrá recuperar el trabajo después de cinco minutos.
 */
const ATTEMPT_LEASE_MS = 5 * 60_000;

const MAX_ERROR_LENGTH = 8_000;

function normalizeError(error: unknown): string {
  const message =
    error instanceof Error
      ? error.stack || error.message
      : String(error);

  return message.slice(0, MAX_ERROR_LENGTH);
}

function calculateNextRetryAt(
  attemptCount: number,
  now: Date
): Date | null {
  const delay =
    RETRY_DELAYS_AFTER_FAILURE_MS[
      attemptCount - 1
    ];

  if (delay === undefined) {
    return null;
  }

  return new Date(now.getTime() + delay);
}

export async function claimAccessRecoveryAttempt(input: {
  prisma: PrismaClient;
  accessGrantId: string;
  operation: AccessRecoveryOperation;
  now?: Date;
}) {
  const now = input.now ?? new Date();

  const grant =
    await input.prisma.accessGrant.findUnique({
      where: {
        id: input.accessGrantId,
      },
      select: {
        id: true,
        status: true,
        recoveryOperation: true,
        recoveryAttemptCount: true,
        recoveryLastAttemptAt: true,
        recoveryNextAttemptAt: true,
        recoveryExhaustedAt: true,
      },
    });

  if (!grant) {
    return {
      claimed: false as const,
      reason: "ACCESS_GRANT_NOT_FOUND" as const,
    };
  }

  if (grant.status !== AccessStatus.ACTIVE) {
    return {
      claimed: false as const,
      reason: "ACCESS_GRANT_NOT_ACTIVE" as const,
    };
  }

  const sameOperation =
    grant.recoveryOperation === input.operation;

  /**
   * Un exhaustion anterior solo bloquea la misma
   * operación. Si en el futuro se inicia otra operación,
   * su presupuesto puede comenzar desde cero.
   */
  if (
    sameOperation &&
    grant.recoveryExhaustedAt
  ) {
    return {
      claimed: false as const,
      reason: "RECOVERY_EXHAUSTED" as const,
    };
  }

  /**
   * Este timestamp puede representar:
   *
   * - el backoff antes del siguiente retry;
   * - el lease de una operación actualmente en ejecución.
   */
  if (
    sameOperation &&
    grant.recoveryNextAttemptAt &&
    grant.recoveryNextAttemptAt > now
  ) {
    return {
      claimed: false as const,
      reason: "RECOVERY_NOT_DUE" as const,
      nextAttemptAt:
        grant.recoveryNextAttemptAt,
    };
  }

  const currentAttemptCount =
    sameOperation
      ? grant.recoveryAttemptCount
      : 0;

  /**
   * Defensa para registros inconsistentes o heredados.
   * Normalmente el último fallo ya habrá establecido
   * recoveryExhaustedAt.
   */
  if (
    currentAttemptCount >=
    MAX_TOTAL_ATTEMPTS
  ) {
    const markedExhausted =
      await input.prisma.accessGrant.updateMany({
        where: {
          id: grant.id,
          status: AccessStatus.ACTIVE,

          // Compare-and-set con el snapshot leído.
          recoveryOperation:
            grant.recoveryOperation,
          recoveryAttemptCount:
            grant.recoveryAttemptCount,
          recoveryLastAttemptAt:
            grant.recoveryLastAttemptAt,
          recoveryNextAttemptAt:
            grant.recoveryNextAttemptAt,
          recoveryExhaustedAt:
            grant.recoveryExhaustedAt,
        },
        data: {
          recoveryOperation: input.operation,
          recoveryNextAttemptAt: null,
          recoveryExhaustedAt: now,
        },
      });

    if (markedExhausted.count === 0) {
      return {
        claimed: false as const,
        reason:
          "RECOVERY_ALREADY_CLAIMED" as const,
      };
    }

    return {
      claimed: false as const,
      reason: "RECOVERY_EXHAUSTED" as const,
    };
  }

  const attemptCount =
    currentAttemptCount + 1;

  const leaseUntil = new Date(
    now.getTime() + ATTEMPT_LEASE_MS
  );

  /**
   * Este updateMany es el claim atómico.
   *
   * Compara los valores exactos que acabamos de leer,
   * incluyendo recoveryOperation = null. De esa manera
   * dos instancias no pueden reclamar el mismo snapshot.
   */
  const claimed =
    await input.prisma.accessGrant.updateMany({
      where: {
        id: grant.id,
        status: AccessStatus.ACTIVE,

        recoveryOperation:
          grant.recoveryOperation,
        recoveryAttemptCount:
          grant.recoveryAttemptCount,
        recoveryLastAttemptAt:
          grant.recoveryLastAttemptAt,
        recoveryNextAttemptAt:
          grant.recoveryNextAttemptAt,
        recoveryExhaustedAt:
          grant.recoveryExhaustedAt,
      },
      data: {
        recoveryOperation: input.operation,
        recoveryAttemptCount: attemptCount,
        recoveryLastAttemptAt: now,

        // Lease mientras TTLock está ejecutándose.
        recoveryNextAttemptAt: leaseUntil,

        // Si cambió la operación, comienza un ciclo nuevo.
        recoveryExhaustedAt: null,
      },
    });

  if (claimed.count === 0) {
    return {
      claimed: false as const,
      reason:
        "RECOVERY_ALREADY_CLAIMED" as const,
    };
  }

  return {
    claimed: true as const,
    attemptCount,
    claimedAt: now,
    leaseUntil,
  };
}

export async function recordAccessRecoveryFailure(input: {
  prisma: PrismaClient;
  accessGrantId: string;
  operation: AccessRecoveryOperation;
  attemptCount: number;
  error: unknown;
  now?: Date;
}) {
  const now = input.now ?? new Date();

  const lastError =
    normalizeError(input.error);

  const exhausted =
    input.attemptCount >=
    MAX_TOTAL_ATTEMPTS;

  const nextAttemptAt = exhausted
    ? null
    : calculateNextRetryAt(
        input.attemptCount,
        now
      );

  /**
   * Solo la ejecución que posee ese número de intento
   * puede registrar su resultado.
   *
   * Si otra ejecución ya completó o avanzó el contador,
   * este update no modifica nada.
   */
  const updated =
    await input.prisma.accessGrant.updateMany({
      where: {
        id: input.accessGrantId,
        status: AccessStatus.ACTIVE,
        recoveryOperation: input.operation,
        recoveryAttemptCount:
          input.attemptCount,
      },
      data: {
        lastError,
        recoveryNextAttemptAt: nextAttemptAt,
        recoveryExhaustedAt: exhausted
          ? now
          : null,
      },
    });

  const applied = updated.count === 1;

  if (applied) {
    try {
      await recordAccessRecoveryOperationalFailure({
        prisma: input.prisma,
        accessGrantId:
          input.accessGrantId,
        operation: input.operation,
        attemptCount:
          input.attemptCount,
        maxAttempts:
          MAX_TOTAL_ATTEMPTS,
        lastError,
        nextAttemptAt,
        exhausted,
        occurredAt: now,
      });
    } catch (operationalError) {
      console.error(
        "[ACCESS_RECOVERY_OPERATIONAL_FAILURE]",
        {
          accessGrantId:
            input.accessGrantId,
          operation: input.operation,
          attemptCount:
            input.attemptCount,
          exhausted,
          error:
            operationalError instanceof Error
              ? operationalError.stack ||
                operationalError.message
              : String(operationalError),
        }
      );
    }
  }

  return {
    applied,
    exhausted,
    nextAttemptAt,
    attemptCount: input.attemptCount,
    lastError,
  };
}

export async function recordAccessRecoverySuccess(input: {
  prisma: PrismaClient;
  accessGrantId: string;
  now?: Date;
}) {
  const now = input.now ?? new Date();

  /**
   * deactivateGrant() marca primero el grant como
   * REVOKED. Solo entonces limpiamos recovery.
   */
  const updated =
    await input.prisma.accessGrant.updateMany({
      where: {
        id: input.accessGrantId,
        status: AccessStatus.REVOKED,
      },
      data: {
        lastError: null,
        recoveryOperation: null,
        recoveryAttemptCount: 0,
        recoveryLastAttemptAt: null,
        recoveryNextAttemptAt: null,
        recoveryExhaustedAt: null,
      },
    });

  const applied = updated.count === 1;

  if (applied) {
    try {
      await resolveAccessRecoveryOperationalIssue({
        prisma: input.prisma,
        accessGrantId:
          input.accessGrantId,
        operation:
          ACCESS_RECOVERY_OPERATION.REVOKE,
        occurredAt: now,
      });
    } catch (operationalError) {
      console.error(
        "[ACCESS_RECOVERY_OPERATIONAL_RESOLUTION_FAILURE]",
        {
          accessGrantId:
            input.accessGrantId,
          operation:
            ACCESS_RECOVERY_OPERATION.REVOKE,
          error:
            operationalError instanceof Error
              ? operationalError.stack ||
                operationalError.message
              : String(operationalError),
        }
      );
    }
  }

  return {
    applied,
  };
}
