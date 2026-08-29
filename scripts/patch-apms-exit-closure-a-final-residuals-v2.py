from pathlib import Path


def read(path: str) -> str:
    return Path(path).read_text(encoding="utf-8")


def write(path: str, text: str) -> None:
    Path(path).write_text(text, encoding="utf-8")


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected 1 anchor, found {count}")
    return text.replace(old, new, 1)


path = "src/e14/guest-access-admission-fence.single-grant.e14.ts"
text = read(path)
text = replace_once(
    text,
    '''  input: {
    now?: Date;
    limit?: number;
  } = {}
) {
''',
    '''  input: {
    now?: Date;
    limit?: number;
    deferActiveSuccessToE15?: boolean;
  } = {}
) {
''',
    "E14_RECOVERY_INPUT",
)
text = replace_once(
    text,
    '''    if (grant.status === "ACTIVE") {
      const durableSuccess = Boolean(
        grant.ttlockKeyboardPwdId &&
          grant.secureAccessCode
      );

''',
    '''    if (grant.status === "ACTIVE") {
      const durableSuccess = Boolean(
        grant.ttlockKeyboardPwdId &&
          grant.secureAccessCode
      );

      if (durableSuccess && input.deferActiveSuccessToE15) {
        if (state === "AMBIGUOUS" && !grant.recoveryNextAttemptAt) {
          ambiguous += 1;
          continue;
        }

        const deferred = await db.accessGrant.updateMany({
          where: compareFenceSnapshot(grant),
          data: {
            recoveryOperation:
              GUEST_ACCESS_PROVISION_OPERATION.AMBIGUOUS,
            recoveryNextAttemptAt: null,
            recoveryExhaustedAt: now,
            lastError:
              "GUEST_ACCESS_PROVISION_AMBIGUOUS:LATE_PROVIDER_SUCCESS_REQUIRES_E15",
          },
        });
        if (deferred.count === 1) ambiguous += 1;
        else races += 1;
        continue;
      }

''',
    "E14_ACTIVE_SUCCESS_DEFER",
)
write(path, text)

path = "src/e14/guest-access-admission-safety-cycle.e14.ts"
text = read(path)
text = replace_once(
    text,
    '''  const recovery =
    await recoverStaleGuestAccessProvisioningFences(
      prisma,
      { now, limit }
    );
''',
    '''  const recovery =
    await recoverStaleGuestAccessProvisioningFences(
      prisma,
      {
        now,
        limit,
        deferActiveSuccessToE15:
          input.e15Enabled === true,
      }
    );
''',
    "E14_SAFETY_DEFER",
)
write(path, text)

path = "src/e14/guest-access-admission-fence.e14.test.ts"
text = read(path)
if "Closure A defers stale ACTIVE durable success to E15" not in text:
    text += '''\n\ntest("Closure A defers stale ACTIVE durable success to E15", async () => {
  const db = new MemoryFenceDb(
    pendingGrant({
      status: "ACTIVE",
      recoveryOperation:
        buildGuestAccessProvisionExecutingOperation("late-success"),
      recoveryAttemptCount: 1,
      recoveryLastAttemptAt: new Date(NOW.getTime() - 120_000),
      recoveryNextAttemptAt: new Date(NOW.getTime() - 60_000),
      ttlockKeyboardPwdId: 5001,
      secureAccessCode: { id: "code-1" },
    })
  ).init();

  await recoverStaleGuestAccessProvisioningFences(db, {
    now: NOW,
    deferActiveSuccessToE15: true,
  });

  assert.equal(
    db.row.recoveryOperation,
    GUEST_ACCESS_PROVISION_OPERATION.AMBIGUOUS
  );
  assert.equal(db.row.recoveryAttemptCount, 1);
  assert.equal(db.row.recoveryNextAttemptAt, null);
  assert.equal(
    db.row.lastError,
    "GUEST_ACCESS_PROVISION_AMBIGUOUS:LATE_PROVIDER_SUCCESS_REQUIRES_E15"
  );
});\n'''
write(path, text)

path = "src/e15/guest-access-reservation-reconciliation-fence.e15-1.ts"
text = read(path)
text = replace_once(
    text,
    '''export type ReconcileLateProviderSuccessE15_1Input =
  ExpectedGrantSnapshot & {
    now: Date;
    providerKeyboardPwdId: number;
    payload: Prisma.InputJsonValue;
  };
''',
    '''export type ReconcileLateProviderSuccessE15_1Input =
  ExpectedGrantSnapshot & {
    now: Date;
    providerKeyboardPwdId: number;
    payload: Prisma.InputJsonValue;
  };

export type QuarantineActiveProviderOutcomeE15_1Input = {
  grantId: string;
  reservationId: string;
  organizationId: string;
  propertyId: string;
  startsAt: Date;
  endsAt: Date;
  ttlockLockId: number;
  now: Date;
  reason: string;
};
''',
    "E151_QUARANTINE_TYPE",
)
anchor = '''export async function rearmAmbiguousGrantUnderReservationFenceE15_1(
'''
if text.count(anchor) != 1:
    raise SystemExit(f"E151_QUARANTINE_FUNCTION_ANCHOR:{text.count(anchor)}")
text = text.replace(
    anchor,
    '''export async function quarantineActiveProviderOutcomeUnderReservationFenceE15_1(
  prisma: PrismaClient,
  input: QuarantineActiveProviderOutcomeE15_1Input
): Promise<boolean> {
  const result = await withReservationFence(
    prisma,
    input.reservationId,
    async (tx, reservation) => {
      if (
        reservation.property.organizationId !== input.organizationId ||
        reservation.propertyId !== input.propertyId
      ) {
        return false;
      }

      const target = reservation.accessGrants.find(
        (grant) => grant.id === input.grantId
      );
      if (
        !target ||
        target.status !== AccessStatus.ACTIVE ||
        !sameInstant(target.startsAt, input.startsAt) ||
        !sameInstant(target.endsAt, input.endsAt) ||
        positiveTtlockLockId(target) !== input.ttlockLockId ||
        !target.ttlockKeyboardPwdId ||
        !target.secureAccessCode
      ) {
        return false;
      }

      const updated = await tx.accessGrant.updateMany({
        where: {
          id: target.id,
          reservationId: reservation.id,
          status: AccessStatus.ACTIVE,
          startsAt: input.startsAt,
          endsAt: input.endsAt,
          recoveryOperation: target.recoveryOperation,
          recoveryAttemptCount: target.recoveryAttemptCount,
          updatedAt: target.updatedAt,
        },
        data: {
          recoveryOperation:
            GUEST_ACCESS_PROVISION_OPERATION.AMBIGUOUS,
          recoveryNextAttemptAt: null,
          recoveryExhaustedAt: input.now,
          lastError: input.reason,
        },
      });
      return updated.count === 1;
    }
  );
  return result === true;
}

''' + anchor,
    1,
)
write(path, text)

path = "src/services/guest-journey-access-owner-adapter.service.ts"
text = read(path)
text = replace_once(
    text,
    '''import {
  buildGuestJourneyAccessOwnerE14OwnerId,
  mapGuestJourneyAccessOwnerE14ProvisionResult,
} from "./guest-access-exit-closure-a.policy";
''',
    '''import {
  buildGuestJourneyAccessOwnerE14OwnerId,
  mapGuestJourneyAccessOwnerE14ProvisionResult,
} from "./guest-access-exit-closure-a.policy";
import {
  quarantineActiveProviderOutcomeUnderReservationFenceE15_1,
} from "../e15/guest-access-reservation-reconciliation-fence.e15-1";
''',
    "ADAPTER_QUARANTINE_IMPORT",
)
text = replace_once(
    text,
    '''  executeProvisioningFence: typeof executeGuestAccessProvisioningWithFence;
  evaluateReadiness: typeof evaluateGuestAccessReadiness;
};
''',
    '''  executeProvisioningFence: typeof executeGuestAccessProvisioningWithFence;
  evaluateReadiness: typeof evaluateGuestAccessReadiness;
  quarantineActiveOutcome:
    typeof quarantineActiveProviderOutcomeUnderReservationFenceE15_1;
};
''',
    "ADAPTER_DEP_TYPE",
)
text = replace_once(
    text,
    '''  executeProvisioningFence: executeGuestAccessProvisioningWithFence,
  evaluateReadiness: evaluateGuestAccessReadiness,
};
''',
    '''  executeProvisioningFence: executeGuestAccessProvisioningWithFence,
  evaluateReadiness: evaluateGuestAccessReadiness,
  quarantineActiveOutcome:
    quarantineActiveProviderOutcomeUnderReservationFenceE15_1,
};
''',
    "ADAPTER_DEFAULT_DEP",
)
text = replace_once(
    text,
    '''  if (releaseUpdate.count !== 1) {
    return {
      kind: "AMBIGUOUS",
      errorCode: "ACCESS_PROVISIONING_RELEASE_PERSISTENCE_FENCE_LOST",
      errorDetail: "Canonical activation returned but the fenced RELEASED transition was not persisted.",
      accessGrantIds: [grant.id],
    };
  }
''',
    '''  if (releaseUpdate.count !== 1) {
    const latest = await loadReservation(prisma, claim);
    if (provisioningSatisfied(latest)) {
      return {
        kind: "SUCCEEDED",
        action: "ALREADY_SATISFIED",
        accessGrantIds: [grant.id],
        outcomeEvidenceFingerprint:
          evidenceFingerprint(latest),
      };
    }

    const active = latest.accessGrants.find(
      (item: any) => item.id === grant.id
    );
    if (
      active?.status === AccessStatus.ACTIVE &&
      active.ttlockKeyboardPwdId &&
      active.secureAccessCode
    ) {
      await dependencies.quarantineActiveOutcome(
        prisma,
        {
          grantId: grant.id,
          reservationId: claim.reservationId,
          organizationId: claim.organizationId,
          propertyId: claim.propertyId,
          startsAt: snapshot.checkIn,
          endsAt: snapshot.checkOut,
          ttlockLockId: Number(active.lock.ttlockLockId),
          now,
          reason:
            "GUEST_ACCESS_PROVISION_AMBIGUOUS:OWNER_RELEASE_PERSISTENCE_FENCE_LOST",
        }
      );
    }

    return {
      kind: "AMBIGUOUS",
      errorCode: "ACCESS_PROVISIONING_RELEASE_PERSISTENCE_FENCE_LOST",
      errorDetail: "Canonical activation returned but the fenced RELEASED transition was not persisted.",
      accessGrantIds: [grant.id],
    };
  }
''',
    "ADAPTER_RELEASE_CAS",
)
write(path, text)

path = "src/services/guest-journey-access-owner-adapter.service.test.ts"
text = read(path)
section_start = text.index("function provisioningDependencies(")
section_end = text.index("\ntest(\"E8 provisions exactly one canonical grant", section_start)
section = text[section_start:section_end]
section = replace_once(
    section,
    '''    assertTenantProviderAuth: async () => undefined,
    activate: async (grantId: string) => {
''',
    '''    assertTenantProviderAuth: async () => undefined,
    quarantineActiveOutcome: async () => true,
    activate: async (grantId: string) => {
''',
    "ADAPTER_TEST_QUARANTINE",
)
text = text[:section_start] + section + text[section_end:]
write(path, text)

path = "src/e15/guest-access-reservation-reconciliation-fence.e15-1.test.ts"
text = read(path)
text = replace_once(
    text,
    '''import {
  adoptProviderCredentialUnderReservationFenceE15_1,
  reconcileLateProviderSuccessUnderReservationFenceE15_1,
  rearmAmbiguousGrantUnderReservationFenceE15_1,
  reconcileAccessIntentUnderReservationFenceE15_1,
} from "./guest-access-reservation-reconciliation-fence.e15-1";
''',
    '''import {
  adoptProviderCredentialUnderReservationFenceE15_1,
  quarantineActiveProviderOutcomeUnderReservationFenceE15_1,
  reconcileLateProviderSuccessUnderReservationFenceE15_1,
  rearmAmbiguousGrantUnderReservationFenceE15_1,
  reconcileAccessIntentUnderReservationFenceE15_1,
} from "./guest-access-reservation-reconciliation-fence.e15-1";
''',
    "E151_TEST_IMPORT",
)
if "Closure A quarantines ACTIVE durable outcome after owner release CAS loss" not in text:
    text += '''\n\ntest("Closure A quarantines ACTIVE durable outcome after owner release CAS loss", async () => {
  const db = buildDb({
    reservation: reservation({
      accessGrants: [grant({
        status: AccessStatus.ACTIVE,
        recoveryOperation: null,
        recoveryAttemptCount: 0,
        ttlockKeyboardPwdId: 5001,
        secureAccessCode: { id: "code1" },
      })],
    }),
  });
  assert.equal(
    await quarantineActiveProviderOutcomeUnderReservationFenceE15_1(
      db.prisma,
      {
        grantId: "g1",
        reservationId: "r1",
        organizationId: "o1",
        propertyId: "p1",
        startsAt: checkIn,
        endsAt: checkOut,
        ttlockLockId: 101,
        now,
        reason: "GUEST_ACCESS_PROVISION_AMBIGUOUS:OWNER_RELEASE_PERSISTENCE_FENCE_LOST",
      }
    ),
    true
  );
  assert.deepEqual(db.calls.slice(0, 4), [
    "TX:Serializable",
    "LOCK_RESERVATION",
    "LOCK_GRANTS",
    "READ_RESERVATION",
  ]);
  assert.equal(db.calls.includes("UPDATE_RESERVATION"), false);
});\n'''
write(path, text)

path = "src/services/guest-access-exit-closure-a.policy.ts"
text = read(path)
text = replace_once(
    text,
    '''export function isGuestAccessE15AutoResolvableOwnerExhaustion(input: {
  e15Enabled: boolean;
  intentType: string;
  lastError: string | null;
}): boolean {
  return (
    input.e15Enabled &&
    input.intentType === "REQUEST_ACCESS_PROVISIONING" &&
    String(input.lastError ?? "").toUpperCase().includes("AMBIGUOUS")
  );
}
''',
    '''export function isGuestAccessE15AutoResolvableOwnerExhaustion(input: {
  e15Enabled: boolean;
  intentType: string;
  lastError: string | null;
  markerState?: GuestAccessE15MarkerState;
}): boolean {
  return (
    input.e15Enabled &&
    input.markerState !== "MANUAL_REVIEW_REQUIRED" &&
    input.intentType === "REQUEST_ACCESS_PROVISIONING" &&
    String(input.lastError ?? "").toUpperCase().includes("AMBIGUOUS")
  );
}
''',
    "POLICY_OWNER_MARKER",
)
write(path, text)

path = "src/services/guest-access-exit-closure-a.policy.test.ts"
text = read(path)
if "manual E15 marker makes owner exhaustion developer-actionable" not in text:
    text += '''\n\ntest("manual E15 marker makes owner exhaustion developer-actionable", () => {
  assert.equal(
    isGuestAccessE15AutoResolvableOwnerExhaustion({
      e15Enabled: true,
      intentType: "REQUEST_ACCESS_PROVISIONING",
      lastError: "ACCESS_PROVISIONING_PROVIDER_RESULT_AMBIGUOUS",
      markerState: "MANUAL_REVIEW_REQUIRED",
    }),
    false
  );
});\n'''
write(path, text)

path = "src/services/guest-journey-access-owner-mission-control.service.ts"
text = read(path)
text = replace_once(
    text,
    '''import {
  guestAccessE15NextAutomaticStep,
  isGuestAccessE15AutoResolvableOwnerExhaustion,
} from "./guest-access-exit-closure-a.policy";
''',
    '''import {
  guestAccessE15MarkerStateFromPayload,
  guestAccessE15NextAutomaticStep,
  isGuestAccessE15AutoResolvableOwnerExhaustion,
} from "./guest-access-exit-closure-a.policy";
''',
    "OWNER_MC_IMPORT",
)
text = replace_once(
    text,
    '''          propertyId: true,
          property: { select: { organizationId: true } },
        },
''',
    '''          propertyId: true,
          property: { select: { organizationId: true } },
          accessGrants: {
            where: {
              type: "GUEST",
              method: "PASSCODE_TIMEBOUND",
            },
            select: { ttlockPayload: true },
          },
        },
''',
    "OWNER_MC_SELECT",
)
text = replace_once(
    text,
    '''  const e15AutoResolving =
    isGuestAccessE15AutoResolvableOwnerExhaustion({
      e15Enabled: expectedScope.e15Enabled === true,
      intentType: intent.intentType,
      lastError: intent.lastError,
    });
''',
    '''  const markerStates =
    intent.reservation.accessGrants.map((grant) =>
      guestAccessE15MarkerStateFromPayload(
        grant.ttlockPayload
      )
    );
  const e15MarkerState =
    markerStates.find(
      (state) => state === "MANUAL_REVIEW_REQUIRED"
    ) ??
    markerStates.find((state) => state !== null) ??
    null;
  const e15AutoResolving =
    isGuestAccessE15AutoResolvableOwnerExhaustion({
      e15Enabled: expectedScope.e15Enabled === true,
      intentType: intent.intentType,
      lastError: intent.lastError,
      markerState: e15MarkerState,
    });
''',
    "OWNER_MC_MARKER_USE",
)
text = replace_once(
    text,
    '''    nextAutomaticStep: e15AutoResolving
      ? guestAccessE15NextAutomaticStep(null)
      : null,
''',
    '''    nextAutomaticStep: e15AutoResolving
      ? guestAccessE15NextAutomaticStep(
          e15MarkerState
        )
      : null,
''',
    "OWNER_MC_NEXT_STEP",
)
text = replace_once(
    text,
    '''      errorCode: intent.lastError,
    },
''',
    '''      errorCode: intent.lastError,
      e15MarkerState,
    },
''',
    "OWNER_MC_METADATA",
)
write(path, text)

print("APMS_EXIT_CLOSURE_A_FINAL_RESIDUALS_V2_APPLIED")
