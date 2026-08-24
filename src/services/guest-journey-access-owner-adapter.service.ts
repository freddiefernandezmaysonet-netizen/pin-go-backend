import { createHash } from "node:crypto";

import {
  AccessGrantType,
  AccessMethod,
  AccessStatus,
  GuestAccessReleaseStatus,
  NfcAssignmentRole,
  NfcAssignmentStatus,
  Prisma,
  PrismaClient,
  ReservationStatus,
} from "@prisma/client";

import {
  ACCESS_RECOVERY_OPERATION,
  claimAccessRecoveryAttempt,
  recordAccessRecoveryFailure,
  recordAccessRecoverySuccess,
} from "./access-recovery.service";
import { isOrgEntitled } from "./billing.entitlement";
import {
  assignNfcCards,
  unassignGuestNfcForReservation,
} from "./nfc.service";
import {
  activateGrant,
  deactivateGrant,
} from "./ttlock/ttlock.brain";
import {
  assertOrgTtlockAuthConfigured,
} from "./ttlock/ttlock.org-auth";
import {
  isGuestJourneyAccessClosureSatisfied,
} from "./guest-journey-contract";
import type {
  AccessOwnerCompletion,
  ClaimedAccessIntent,
} from "./guest-journey-access-owner-runtime.service";

type AdapterDependencies = {
  activate: typeof activateGrant;
  deactivate: typeof deactivateGrant;
  claimRecovery: typeof claimAccessRecoveryAttempt;
  recordRecoveryFailure: typeof recordAccessRecoveryFailure;
  recordRecoverySuccess: typeof recordAccessRecoverySuccess;
  assignNfc: typeof assignNfcCards;
  unassignGuestNfc: typeof unassignGuestNfcForReservation;
  isEntitled: typeof isOrgEntitled;
  assertTenantProviderAuth: typeof assertOrgTtlockAuthConfigured;
};

const DEFAULT_DEPENDENCIES: AdapterDependencies = {
  activate: activateGrant,
  deactivate: deactivateGrant,
  claimRecovery: claimAccessRecoveryAttempt,
  recordRecoveryFailure: recordAccessRecoveryFailure,
  recordRecoverySuccess: recordAccessRecoverySuccess,
  assignNfc: assignNfcCards,
  unassignGuestNfc: unassignGuestNfcForReservation,
  isEntitled: isOrgEntitled,
  assertTenantProviderAuth: assertOrgTtlockAuthConfigured,
};

const reservationSelect = {
  id: true,
  propertyId: true,
  status: true,
  checkIn: true,
  checkOut: true,
  guestAccessModeSnapshot: true,
  guestAccessReleaseStatus: true,
  guestAccessReleasedAt: true,
  property: { select: { organizationId: true } },
  accessGrants: {
    where: { type: AccessGrantType.GUEST },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      method: true,
      status: true,
      startsAt: true,
      endsAt: true,
      ttlockKeyboardPwdId: true,
      recoveryOperation: true,
      recoveryAttemptCount: true,
      recoveryNextAttemptAt: true,
      recoveryExhaustedAt: true,
      secureAccessCode: { select: { id: true } },
      lock: { select: { ttlockLockId: true } },
    },
  },
  NfcAssignment: {
    where: { role: NfcAssignmentRole.GUEST },
    select: { id: true, status: true },
  },
} satisfies Prisma.ReservationSelect;

function normalizedError(error: unknown): { code: string; detail: string } {
  const raw = error instanceof Error ? error.message : String(error);
  const code = raw
    .split(":", 1)[0]
    .trim()
    .replace(/[^A-Z0-9_]/gi, "_")
    .toUpperCase() || "ACCESS_OWNER_ADAPTER_ERROR";
  return {
    code,
    detail: raw
      .replace(/\b(passcode|password|secret|token|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
      .slice(0, 8_000),
  };
}

function isAmbiguousProviderError(error: unknown): boolean {
  const value = (error instanceof Error ? error.message : String(error))
    .trim()
    .toUpperCase();
  return [
    "TIMEOUT",
    "TIMED_OUT",
    "ETIMEDOUT",
    "ECONNRESET",
    "SOCKET_HANG_UP",
    "ABORTED",
    "NETWORK_ERROR",
    "PROVIDER_RESULT_AMBIGUOUS",
  ].some((marker) => value.includes(marker));
}

async function withProviderTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("ACCESS_PROVIDER_RESULT_AMBIGUOUS_TIMEOUT")),
          timeoutMs
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function evidenceFingerprint(reservation: any): string {
  return createHash("sha256")
    .update(JSON.stringify({
      reservationId: reservation.id,
      status: reservation.status,
      checkIn: reservation.checkIn.toISOString(),
      checkOut: reservation.checkOut.toISOString(),
      releaseStatus: reservation.guestAccessReleaseStatus,
      releasedAt: reservation.guestAccessReleasedAt?.toISOString() ?? null,
      grants: reservation.accessGrants.map((grant: any) => ({
        id: grant.id,
        method: grant.method,
        status: grant.status,
        startsAt: grant.startsAt.toISOString(),
        endsAt: grant.endsAt.toISOString(),
        keyboardPwdIdPresent: Boolean(grant.ttlockKeyboardPwdId),
        secureCodePresent: Boolean(grant.secureAccessCode),
        recoveryOperation: grant.recoveryOperation,
        recoveryAttemptCount: grant.recoveryAttemptCount,
        recoveryNextAttemptAt: grant.recoveryNextAttemptAt?.toISOString() ?? null,
        recoveryExhaustedAt: grant.recoveryExhaustedAt?.toISOString() ?? null,
      })),
      nfc: reservation.NfcAssignment
        .map((item: any) => ({ id: item.id, status: item.status }))
        .sort((a: any, b: any) => a.id.localeCompare(b.id)),
    }))
    .digest("hex");
}

async function loadReservation(
  prisma: PrismaClient,
  claim: ClaimedAccessIntent
): Promise<any> {
  const reservation = await prisma.reservation.findUnique({
    where: { id: claim.reservationId },
    select: reservationSelect,
  });
  if (!reservation) throw new Error("ACCESS_OWNER_RESERVATION_NOT_FOUND");
  if (
    reservation.propertyId !== claim.propertyId ||
    reservation.property.organizationId !== claim.organizationId
  ) {
    throw new Error("ACCESS_OWNER_RESERVATION_SCOPE_MISMATCH");
  }
  return reservation;
}

function activeNfc(snapshot: any): number {
  return snapshot.NfcAssignment.filter((item: any) =>
    [
      NfcAssignmentStatus.SCHEDULED,
      NfcAssignmentStatus.PROVISIONING,
      NfcAssignmentStatus.ACTIVE,
      NfcAssignmentStatus.FAILED,
    ].includes(item.status)
  ).length;
}

function provisioningSatisfied(snapshot: any): boolean {
  return (
    snapshot.guestAccessReleaseStatus === GuestAccessReleaseStatus.RELEASED &&
    Boolean(snapshot.guestAccessReleasedAt) &&
    snapshot.accessGrants.some((grant: any) =>
      grant.method === AccessMethod.PASSCODE_TIMEBOUND &&
      grant.status === AccessStatus.ACTIVE &&
      grant.startsAt.getTime() === snapshot.checkIn.getTime() &&
      grant.endsAt.getTime() === snapshot.checkOut.getTime() &&
      Boolean(grant.ttlockKeyboardPwdId) &&
      Boolean(grant.secureAccessCode)
    )
  );
}

function closureSatisfied(snapshot: any): boolean {
  const guestGrantsOpen = snapshot.accessGrants.filter((grant: any) =>
    grant.status !== AccessStatus.REVOKED
  ).length;
  const guestGrantsRevoked = snapshot.accessGrants.filter((grant: any) =>
    grant.status === AccessStatus.REVOKED
  ).length;
  return isGuestJourneyAccessClosureSatisfied({
    releaseStatus: snapshot.guestAccessReleaseStatus,
    guestGrantsOpen,
    guestGrantsRevoked,
    unresolvedGuestNfcCount: activeNfc(snapshot),
  });
}

async function executeProvisioning(
  prisma: PrismaClient,
  claim: ClaimedAccessIntent,
  now: Date,
  provisionLeadMs: number,
  providerTimeoutMs: number,
  dependencies: AdapterDependencies
): Promise<AccessOwnerCompletion> {
  let snapshot = await loadReservation(prisma, claim);
  if (provisioningSatisfied(snapshot)) {
    return {
      kind: "SUCCEEDED",
      action: "ALREADY_SATISFIED",
      accessGrantIds: snapshot.accessGrants.map((grant: any) => grant.id),
      outcomeEvidenceFingerprint: evidenceFingerprint(snapshot),
    };
  }
  if (
    snapshot.status !== ReservationStatus.ACTIVE ||
    snapshot.checkOut.getTime() <= now.getTime()
  ) {
    return {
      kind: "WAITING_FOR_EVIDENCE",
      errorCode: "ACCESS_PROVISIONING_NO_LONGER_ELIGIBLE",
      errorDetail: "The reservation is no longer active inside its access window.",
      outcomeEvidenceFingerprint: evidenceFingerprint(snapshot),
    };
  }
  if (snapshot.guestAccessReleaseStatus !== GuestAccessReleaseStatus.ELIGIBLE) {
    return {
      kind: "WAITING_FOR_EVIDENCE",
      errorCode: "ACCESS_ELIGIBILITY_EVIDENCE_MISSING",
      errorDetail: "Canonical ACCESS eligibility must be persisted before provisioning.",
      outcomeEvidenceFingerprint: evidenceFingerprint(snapshot),
    };
  }
  if (snapshot.checkIn.getTime() > now.getTime() + provisionLeadMs) {
    return {
      kind: "RETRYABLE",
      errorCode: "ACCESS_PROVISIONING_WINDOW_NOT_OPEN",
      errorDetail: "The canonical two-hour provisioning window is not open.",
      retryAt: new Date(snapshot.checkIn.getTime() - provisionLeadMs),
      outcomeEvidenceFingerprint: evidenceFingerprint(snapshot),
    };
  }

  const entitlement = await dependencies.isEntitled(
    claim.organizationId,
    now
  );
  if (!entitlement.ok) {
    return {
      kind: "RETRYABLE",
      errorCode: "ACCESS_PROVISIONING_ORGANIZATION_NOT_ENTITLED",
      errorDetail: `Canonical billing entitlement blocked ACCESS: ${entitlement.reason}.`,
      outcomeEvidenceFingerprint: evidenceFingerprint(snapshot),
    };
  }

  const candidates = snapshot.accessGrants.filter((grant: any) =>
    grant.method === AccessMethod.PASSCODE_TIMEBOUND &&
    grant.status === AccessStatus.PENDING &&
    grant.startsAt.getTime() === snapshot.checkIn.getTime() &&
    grant.endsAt.getTime() === snapshot.checkOut.getTime()
  );
  if (candidates.length !== 1) {
    const failed = snapshot.accessGrants.some((grant: any) =>
      grant.method === AccessMethod.PASSCODE_TIMEBOUND &&
      grant.status === AccessStatus.FAILED
    );
    return {
      kind: failed ? "AMBIGUOUS" : "WAITING_FOR_EVIDENCE",
      errorCode: failed
        ? "ACCESS_PROVISIONING_FAILED_GRANT_REQUIRES_RECONCILIATION"
        : "ACCESS_PROVISIONING_CANONICAL_GRANT_MISSING_OR_AMBIGUOUS",
      errorDetail: "Exactly one pending canonical time-bound passcode grant is required.",
      accessGrantIds: snapshot.accessGrants.map((grant: any) => grant.id),
      outcomeEvidenceFingerprint: evidenceFingerprint(snapshot),
    };
  }

  const grant = candidates[0];
  snapshot = await loadReservation(prisma, claim);
  const refenced = snapshot.accessGrants.find((item: any) => item.id === grant.id);
  if (
    snapshot.status !== ReservationStatus.ACTIVE ||
    snapshot.guestAccessReleaseStatus !== GuestAccessReleaseStatus.ELIGIBLE ||
    !refenced ||
    refenced.status !== AccessStatus.PENDING ||
    refenced.method !== AccessMethod.PASSCODE_TIMEBOUND ||
    refenced.startsAt.getTime() !== snapshot.checkIn.getTime() ||
    refenced.endsAt.getTime() !== snapshot.checkOut.getTime()
  ) {
    return {
      kind: "WAITING_FOR_EVIDENCE",
      errorCode: "ACCESS_PROVISIONING_REFENCE_LOST",
      errorDetail: "Reservation, eligibility, method, status, or access window changed before provider execution.",
      accessGrantIds: [grant.id],
      outcomeEvidenceFingerprint: evidenceFingerprint(snapshot),
    };
  }

  try {
    await dependencies.assertTenantProviderAuth(
      prisma,
      claim.organizationId
    );
  } catch (error) {
    const normalized = normalizedError(error);
    return {
      kind: "WAITING_FOR_EVIDENCE",
      errorCode: "ACCESS_TENANT_TTLOCK_AUTH_MISSING",
      errorDetail: normalized.detail,
      accessGrantIds: [grant.id],
      outcomeEvidenceFingerprint: evidenceFingerprint(snapshot),
    };
  }

  try {
    const activation = await withProviderTimeout(
      dependencies.activate(grant.id),
      providerTimeoutMs
    );
    if ((activation as any)?.ok !== true && !(activation as any)?.skipped) {
      throw new Error(`ACCESS_PROVISIONING_CANONICAL_ACTIVATION_FAILED:${(activation as any)?.reason ?? "UNKNOWN"}`);
    }
  } catch (error) {
    const normalized = normalizedError(error);
    return {
      kind: isAmbiguousProviderError(error) ? "AMBIGUOUS" : "RETRYABLE",
      errorCode: isAmbiguousProviderError(error)
        ? "ACCESS_PROVISIONING_PROVIDER_RESULT_AMBIGUOUS"
        : normalized.code,
      errorDetail: normalized.detail,
      accessGrantIds: [grant.id],
    };
  }

  const releasedAt = now;
  const releaseUpdate = await prisma.reservation.updateMany({
    where: {
      id: claim.reservationId,
      propertyId: claim.propertyId,
      status: ReservationStatus.ACTIVE,
      guestAccessReleaseStatus: GuestAccessReleaseStatus.ELIGIBLE,
      checkIn: snapshot.checkIn,
      checkOut: snapshot.checkOut,
    },
    data: {
      guestAccessReleaseStatus: GuestAccessReleaseStatus.RELEASED,
      guestAccessReleasedAt: releasedAt,
      guestAccessReleaseLastError: null,
    },
  });
  if (releaseUpdate.count !== 1) {
    return {
      kind: "AMBIGUOUS",
      errorCode: "ACCESS_PROVISIONING_RELEASE_PERSISTENCE_FENCE_LOST",
      errorDetail: "Canonical activation returned but the fenced RELEASED transition was not persisted.",
      accessGrantIds: [grant.id],
    };
  }

  snapshot = await loadReservation(prisma, claim);
  const activated = snapshot.accessGrants.find((item: any) => item.id === grant.id);
  if (
    !activated ||
    activated.status !== AccessStatus.ACTIVE ||
    !activated.ttlockKeyboardPwdId ||
    !activated.secureAccessCode
  ) {
    return {
      kind: "AMBIGUOUS",
      errorCode: "ACCESS_PROVISIONING_OUTCOME_EVIDENCE_INCOMPLETE",
      errorDetail: "Canonical activation returned without complete persisted provider and secure-code evidence.",
      accessGrantIds: [grant.id],
      outcomeEvidenceFingerprint: evidenceFingerprint(snapshot),
    };
  }

  if (snapshot.guestAccessModeSnapshot === "PASSCODE_PLUS_NFC") {
    const existingGuestNfc = snapshot.NfcAssignment.filter((item: any) =>
      [
        NfcAssignmentStatus.SCHEDULED,
        NfcAssignmentStatus.PROVISIONING,
        NfcAssignmentStatus.ACTIVE,
        NfcAssignmentStatus.FAILED,
      ].includes(item.status)
    ).length;
    const cardsNeeded = Math.max(2 - existingGuestNfc, 0);
    if (cardsNeeded > 0) {
      const lockId = Number(activated.lock.ttlockLockId);
      if (!Number.isFinite(lockId) || lockId <= 0) {
        return {
          kind: "WAITING_FOR_EVIDENCE",
          errorCode: "ACCESS_NFC_LOCK_EVIDENCE_MISSING",
          errorDetail: "NFC scheduling requires the canonical TTLock lock identifier.",
          accessGrantIds: [grant.id],
          outcomeEvidenceFingerprint: evidenceFingerprint(snapshot),
        };
      }
      await dependencies.assignNfc(prisma, {
        reservationId: claim.reservationId,
        ttlockLockId: lockId,
        propertyId: claim.propertyId,
        role: NfcAssignmentRole.GUEST,
        startsAt: snapshot.checkIn,
        endsAt: snapshot.checkOut,
        count: cardsNeeded,
        skipTtlock: true,
      });
    }
  }

  snapshot = await loadReservation(prisma, claim);
  return {
    kind: "SUCCEEDED",
    action: "PROVISIONED",
    accessGrantIds: [grant.id],
    outcomeEvidenceFingerprint: evidenceFingerprint(snapshot),
  };
}

async function executeRevocation(
  prisma: PrismaClient,
  claim: ClaimedAccessIntent,
  now: Date,
  providerTimeoutMs: number,
  dependencies: AdapterDependencies
): Promise<AccessOwnerCompletion> {
  let snapshot = await loadReservation(prisma, claim);
  if (closureSatisfied(snapshot)) {
    return {
      kind: "SUCCEEDED",
      action: "ALREADY_SATISFIED",
      accessGrantIds: snapshot.accessGrants.map((grant: any) => grant.id),
      outcomeEvidenceFingerprint: evidenceFingerprint(snapshot),
    };
  }
  if (
    snapshot.status !== ReservationStatus.CANCELLED &&
    snapshot.checkOut.getTime() > now.getTime()
  ) {
    return {
      kind: "RETRYABLE",
      errorCode: "ACCESS_REVOCATION_WINDOW_NOT_OPEN",
      errorDetail: "Guest access cannot be revoked before checkout unless the reservation is cancelled.",
      retryAt: snapshot.checkOut,
      outcomeEvidenceFingerprint: evidenceFingerprint(snapshot),
    };
  }

  const active = snapshot.accessGrants.filter((grant: any) =>
    grant.status === AccessStatus.ACTIVE
  );
  const grantIds = active.map((grant: any) => grant.id);
  for (const grant of active) {
    const recovery = await dependencies.claimRecovery({
      prisma,
      accessGrantId: grant.id,
      operation: ACCESS_RECOVERY_OPERATION.REVOKE,
      now,
    });
    if (!recovery.claimed) {
      if (recovery.reason === "RECOVERY_NOT_DUE") {
        return {
          kind: "RETRYABLE",
          errorCode: "ACCESS_REVOCATION_RECOVERY_NOT_DUE",
          errorDetail: "Canonical access recovery is still in backoff or owns a live lease.",
          retryAt: recovery.nextAttemptAt,
          accessGrantIds: grantIds,
          outcomeEvidenceFingerprint: evidenceFingerprint(snapshot),
        };
      }
      if (recovery.reason === "RECOVERY_EXHAUSTED") {
        return {
          kind: "AMBIGUOUS",
          errorCode: "ACCESS_REVOCATION_RECOVERY_EXHAUSTED",
          errorDetail: "Canonical access recovery exhausted without complete closure evidence.",
          accessGrantIds: grantIds,
          outcomeEvidenceFingerprint: evidenceFingerprint(snapshot),
        };
      }
      if (recovery.reason === "RECOVERY_ALREADY_CLAIMED") {
        return {
          kind: "RETRYABLE",
          errorCode: "ACCESS_REVOCATION_RECOVERY_ALREADY_CLAIMED",
          errorDetail: "Another fenced recovery owner won the access-grant claim.",
          accessGrantIds: grantIds,
        };
      }
      continue;
    }

    try {
      await dependencies.assertTenantProviderAuth(
        prisma,
        claim.organizationId
      );
    } catch (error) {
      const normalized = normalizedError(error);
      return {
        kind: "WAITING_FOR_EVIDENCE",
        errorCode: "ACCESS_TENANT_TTLOCK_AUTH_MISSING",
        errorDetail: normalized.detail,
        accessGrantIds: grantIds,
        outcomeEvidenceFingerprint: evidenceFingerprint(snapshot),
      };
    }

    try {
      await withProviderTimeout(
        dependencies.deactivate(grant.id),
        providerTimeoutMs
      );
    } catch (error) {
      const failure = await dependencies.recordRecoveryFailure({
        prisma,
        accessGrantId: grant.id,
        operation: ACCESS_RECOVERY_OPERATION.REVOKE,
        attemptCount: recovery.attemptCount,
        error,
        now: new Date(),
      });
      const normalized = normalizedError(error);
      return {
        kind: isAmbiguousProviderError(error) || failure.exhausted
          ? "AMBIGUOUS"
          : "RETRYABLE",
        errorCode: isAmbiguousProviderError(error)
          ? "ACCESS_REVOCATION_PROVIDER_RESULT_AMBIGUOUS"
          : failure.exhausted
            ? "ACCESS_REVOCATION_RECOVERY_EXHAUSTED"
            : normalized.code,
        errorDetail: normalized.detail,
        retryAt: failure.nextAttemptAt,
        accessGrantIds: grantIds,
      };
    }

    const success = await dependencies.recordRecoverySuccess({
      prisma,
      accessGrantId: grant.id,
    });
    if (!success.applied) {
      return {
        kind: "AMBIGUOUS",
        errorCode: "ACCESS_REVOCATION_RECOVERY_SUCCESS_NOT_PERSISTED",
        errorDetail: "Provider revocation returned but canonical recovery cleanup did not confirm REVOKED evidence.",
        accessGrantIds: grantIds,
      };
    }
  }

  snapshot = await loadReservation(prisma, claim);
  const nfcOpen = activeNfc(snapshot);
  if (nfcOpen > 0) {
    const lockId = Number(
      snapshot.accessGrants.find((grant: any) => grant.lock.ttlockLockId)?.lock.ttlockLockId
    );
    if (!Number.isFinite(lockId) || lockId <= 0) {
      return {
        kind: "AMBIGUOUS",
        errorCode: "ACCESS_NFC_REVOCATION_LOCK_EVIDENCE_MISSING",
        errorDetail: "Guest NFC remains open without a canonical TTLock lock identifier.",
        accessGrantIds: grantIds,
        outcomeEvidenceFingerprint: evidenceFingerprint(snapshot),
      };
    }
    try {
      await dependencies.assertTenantProviderAuth(
        prisma,
        claim.organizationId
      );
    } catch (error) {
      const normalized = normalizedError(error);
      return {
        kind: "WAITING_FOR_EVIDENCE",
        errorCode: "ACCESS_TENANT_TTLOCK_AUTH_MISSING",
        errorDetail: normalized.detail,
        accessGrantIds: grantIds,
        outcomeEvidenceFingerprint: evidenceFingerprint(snapshot),
      };
    }
    const nfcResult = await withProviderTimeout(
      dependencies.unassignGuestNfc(prisma, {
        reservationId: claim.reservationId,
        ttlockLockId: lockId,
      }),
      providerTimeoutMs
    ).catch((error) => ({ error }));
    if ("error" in nfcResult) {
      const normalized = normalizedError(nfcResult.error);
      return {
        kind: isAmbiguousProviderError(nfcResult.error) ? "AMBIGUOUS" : "RETRYABLE",
        errorCode: isAmbiguousProviderError(nfcResult.error)
          ? "ACCESS_NFC_REVOCATION_PROVIDER_RESULT_AMBIGUOUS"
          : normalized.code,
        errorDetail: normalized.detail,
        accessGrantIds: grantIds,
      };
    }
    if (nfcResult.ended !== nfcResult.totalActive) {
      return {
        kind: "AMBIGUOUS",
        errorCode: "ACCESS_NFC_REVOCATION_INCOMPLETE",
        errorDetail: "Canonical NFC revocation did not confirm every active guest card as ended.",
        accessGrantIds: grantIds,
      };
    }
  }

  snapshot = await loadReservation(prisma, claim);
  if (!closureSatisfied(snapshot)) {
    return {
      kind: "AMBIGUOUS",
      errorCode: "ACCESS_CLOSURE_EVIDENCE_INCOMPLETE",
      errorDetail: "Guest grants or NFC assignments remain open after canonical revocation.",
      accessGrantIds: snapshot.accessGrants.map((grant: any) => grant.id),
      outcomeEvidenceFingerprint: evidenceFingerprint(snapshot),
    };
  }
  return {
    kind: "SUCCEEDED",
    action: "REVOKED",
    accessGrantIds: snapshot.accessGrants.map((grant: any) => grant.id),
    outcomeEvidenceFingerprint: evidenceFingerprint(snapshot),
  };
}

export async function executeGuestJourneyAccessOwnerAdapter(
  prisma: PrismaClient,
  claim: ClaimedAccessIntent,
  options: {
    now?: Date;
    provisionLeadMs: number;
    providerTimeoutMs: number;
    dependencies?: Partial<AdapterDependencies>;
  }
): Promise<{ completion: AccessOwnerCompletion; providerCalls: number }> {
  const now = options.now ?? new Date();
  if (Number.isNaN(now.getTime())) throw new Error("ACCESS_OWNER_ADAPTER_NOW_INVALID");
  if (!Number.isSafeInteger(options.providerTimeoutMs) || options.providerTimeoutMs < 1) {
    throw new Error("ACCESS_OWNER_ADAPTER_PROVIDER_TIMEOUT_INVALID");
  }
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...options.dependencies };
  let providerCalls = 0;
  const countedDependencies: AdapterDependencies = {
    ...dependencies,
    activate: (accessGrantId) => {
      providerCalls += 1;
      return dependencies.activate(accessGrantId);
    },
    deactivate: (accessGrantId) => {
      providerCalls += 1;
      return dependencies.deactivate(accessGrantId);
    },
    unassignGuestNfc: (client, input) => {
      providerCalls += 1;
      return dependencies.unassignGuestNfc(client, input);
    },
  };
  const completion = claim.intentType === "REQUEST_ACCESS_PROVISIONING"
    ? await executeProvisioning(
        prisma,
        claim,
        now,
        options.provisionLeadMs,
        options.providerTimeoutMs,
        countedDependencies
      )
    : await executeRevocation(
        prisma,
        claim,
        now,
        options.providerTimeoutMs,
        countedDependencies
      );
  return { completion, providerCalls };
}
