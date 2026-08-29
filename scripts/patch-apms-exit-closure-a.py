from pathlib import Path

def read(path):
    return Path(path).read_text(encoding="utf-8")

def write(path, text):
    Path(path).write_text(text, encoding="utf-8")

def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected 1 anchor, found {count}")
    return text.replace(old, new, 1)

def insert_before_once(text, anchor, insertion, label):
    count = text.count(anchor)
    if count != 1:
        raise SystemExit(f"{label}: expected 1 anchor, found {count}")
    return text.replace(anchor, insertion + anchor, 1)

path = "src/services/guest-journey-access-owner-adapter.service.ts"
text = read(path)
text = replace_once(text, '''import {
  isGuestJourneyAccessClosureSatisfied,
} from "./guest-journey-contract";
import type {
''', '''import {
  isGuestJourneyAccessClosureSatisfied,
} from "./guest-journey-contract";
import {
  executeGuestAccessProvisioningWithFence,
} from "../e14/guest-access-admission-fence.service.e14";
import {
  buildGuestJourneyAccessOwnerE14OwnerId,
  mapGuestJourneyAccessOwnerE14ProvisionResult,
} from "./guest-access-exit-closure-a.policy";
import {
  quarantineActiveProviderOutcomeUnderReservationFenceE15_1,
} from "../e15/guest-access-reservation-reconciliation-fence.e15-1";
import type {
''', "ADAPTER_IMPORT_ANCHOR")
text = replace_once(text, '''  assertTenantProviderAuth: typeof assertOrgTtlockAuthConfigured;
};
''', '''  assertTenantProviderAuth: typeof assertOrgTtlockAuthConfigured;
  executeFencedProvisioning: typeof executeGuestAccessProvisioningWithFence;
  quarantineActiveOutcome: typeof quarantineActiveProviderOutcomeUnderReservationFenceE15_1;
};
''', "ADAPTER_DEPS_TYPE")
text = replace_once(text, '''  isEntitled: isOrgEntitled,
  assertTenantProviderAuth: assertOrgTtlockAuthConfigured,
};
''', '''  isEntitled: isOrgEntitled,
  assertTenantProviderAuth: assertOrgTtlockAuthConfigured,
  executeFencedProvisioning: executeGuestAccessProvisioningWithFence,
  quarantineActiveOutcome: quarantineActiveProviderOutcomeUnderReservationFenceE15_1,
};
''', "ADAPTER_DEFAULT_DEPS")
start = text.index('''  try {
    const activation = await withProviderTimeout(
      dependencies.activate(grant.id),
      providerTimeoutMs
    );''')
end = text.index("\n\n  const releasedAt = now;", start)
new_provider = '''  const fencedProvisioning =
    await dependencies.executeFencedProvisioning(
      prisma,
      {
        accessGrantId: grant.id,
        reservationId: claim.reservationId,
        ownerId: buildGuestJourneyAccessOwnerE14OwnerId({
          intentId: claim.intentId,
          attemptNumber: claim.attemptNumber,
        }),
        now,
        physicalTimeoutMs: providerTimeoutMs,
        evaluateReadiness: async (_reservationId, evaluatedAt) => {
          const latest = await loadReservation(prisma, claim);
          const canonical = latest.accessGrants.filter((item: any) =>
            item.method === AccessMethod.PASSCODE_TIMEBOUND &&
            item.status === AccessStatus.PENDING &&
            item.startsAt.getTime() === latest.checkIn.getTime() &&
            item.endsAt.getTime() === latest.checkOut.getTime()
          );
          return {
            ready:
              latest.status === ReservationStatus.ACTIVE &&
              latest.guestAccessReleaseStatus === GuestAccessReleaseStatus.ELIGIBLE &&
              latest.checkOut.getTime() > evaluatedAt.getTime() &&
              canonical.length === 1 &&
              canonical[0]?.id === grant.id,
          };
        },
        executePhysical: () => dependencies.activate(grant.id),
      }
    );

  const mappedProvisioning =
    mapGuestJourneyAccessOwnerE14ProvisionResult(
      fencedProvisioning,
      grant.id
    );
  if (!mappedProvisioning.proceed) {
    return mappedProvisioning.completion;
  }'''
text = text[:start] + new_provider + text[end:]
text = replace_once(text, '''  if (releaseUpdate.count !== 1) {
    return {
      kind: "AMBIGUOUS",
      errorCode: "ACCESS_PROVISIONING_RELEASE_PERSISTENCE_FENCE_LOST",
      errorDetail: "Canonical activation returned but the fenced RELEASED transition was not persisted.",
      accessGrantIds: [grant.id],
    };
  }
''', '''  if (releaseUpdate.count !== 1) {
    const latest = await loadReservation(prisma, claim);
    if (provisioningSatisfied(latest)) {
      return {
        kind: "SUCCEEDED",
        action: "ALREADY_SATISFIED",
        accessGrantIds: [grant.id],
        outcomeEvidenceFingerprint: evidenceFingerprint(latest),
      };
    }

    await dependencies.quarantineActiveOutcome(
      prisma,
      {
        grantId: grant.id,
        reservationId: claim.reservationId,
        organizationId: claim.organizationId,
        propertyId: claim.propertyId,
        startsAt: snapshot.checkIn,
        endsAt: snapshot.checkOut,
        ttlockLockId: Number(refenced.lock.ttlockLockId),
        now,
        reason:
          "GUEST_ACCESS_PROVISION_AMBIGUOUS:OWNER_RELEASE_PERSISTENCE_FENCE_LOST",
      }
    );

    return {
      kind: "AMBIGUOUS",
      errorCode: "ACCESS_PROVISIONING_RELEASE_PERSISTENCE_FENCE_LOST",
      errorDetail: "Canonical activation returned but the fenced RELEASED transition was not persisted.",
      accessGrantIds: [grant.id],
    };
  }
''', "ADAPTER_RELEASE_CAS")
write(path, text)

path = "src/services/guest-journey-access-owner-adapter.service.test.ts"
text = read(path)
text = replace_once(text, '''    assignNfc: async () => [],
    ...overrides,
''', '''    assignNfc: async () => [],
    executeFencedProvisioning: async (_db: unknown, input: any) => {
      const activation = await input.executePhysical();
      return {
        status: "SUCCEEDED",
        activation,
        fenceCleared: true,
        attemptCount: 1,
      };
    },
    quarantineActiveOutcome: async () => true,
    ...overrides,
''', "ADAPTER_TEST_DEFAULT_FENCE")
if "Closure A routes Access Owner provisioning through E14.1" not in text:
    text += '''\n\ntest("Closure A routes Access Owner provisioning through E14.1", async () => {
  const state = snapshot();
  let fenceCalls = 0;
  let physicalCalls = 0;
  const result = await executeGuestJourneyAccessOwnerAdapter(
    fakePrisma(state),
    claim(),
    {
      now,
      provisionLeadMs: 2 * 60 * 60_000,
      providerTimeoutMs: 100,
      dependencies: provisioningDependencies(state, {
        executeFencedProvisioning: async (_db: unknown, input: any) => {
          fenceCalls += 1;
          assert.equal(input.accessGrantId, "grant-1");
          assert.equal(input.reservationId, "reservation-1");
          assert.match(input.ownerId, /^guest-journey-access-owner:intent-1:1$/);
          const readiness = await input.evaluateReadiness("reservation-1", now);
          assert.equal(readiness.ready, true);
          const activation = await input.executePhysical();
          return { status: "SUCCEEDED", activation, fenceCleared: true, attemptCount: 1 };
        },
        activate: async () => {
          physicalCalls += 1;
          state.accessGrants[0].status = AccessStatus.ACTIVE;
          state.accessGrants[0].ttlockKeyboardPwdId = 123;
          state.accessGrants[0].secureAccessCode = { id: "code-1" };
          return { ok: true, keyboardPwdId: 123 };
        },
      }),
    }
  );
  assert.equal(fenceCalls, 1);
  assert.equal(physicalCalls, 1);
  assert.equal(result.completion.kind, "SUCCEEDED");
  assert.equal(result.providerCalls, 1);
});

test("Closure A maps E14 timeout ambiguity without a second provider call", async () => {
  const state = snapshot();
  let physicalCalls = 0;
  const result = await executeGuestJourneyAccessOwnerAdapter(
    fakePrisma(state), claim(), {
      now,
      provisionLeadMs: 2 * 60 * 60_000,
      providerTimeoutMs: 100,
      dependencies: provisioningDependencies(state, {
        executeFencedProvisioning: async (_db: unknown, input: any) => {
          await input.executePhysical();
          return { status: "AMBIGUOUS", reason: "GUEST_ACCESS_PROVISION_RESULT_AMBIGUOUS_TIMEOUT", attemptCount: 1 };
        },
        activate: async () => { physicalCalls += 1; return { ok: true }; },
      }),
    }
  );
  assert.equal(physicalCalls, 1);
  assert.equal(result.providerCalls, 1);
  assert.equal(result.completion.kind, "AMBIGUOUS");
  assert.equal(state.guestAccessReleaseStatus, GuestAccessReleaseStatus.ELIGIBLE);
});

test("Closure A performs zero provider calls when E14 blocks before the boundary", async () => {
  const state = snapshot();
  let physicalCalls = 0;
  const result = await executeGuestJourneyAccessOwnerAdapter(
    fakePrisma(state), claim(), {
      now,
      provisionLeadMs: 2 * 60 * 60_000,
      providerTimeoutMs: 100,
      dependencies: provisioningDependencies(state, {
        executeFencedProvisioning: async () => ({ status: "WAITING_FOR_EVIDENCE", reason: "CANONICAL_ACCESS_READINESS_NOT_ELIGIBLE", attemptCount: 1 }),
        activate: async () => { physicalCalls += 1; return { ok: true }; },
      }),
    }
  );
  assert.equal(physicalCalls, 0);
  assert.equal(result.providerCalls, 0);
  assert.equal(result.completion.kind, "WAITING_FOR_EVIDENCE");
});\n'''
write(path, text)

path = "src/e14/guest-access-admission-fence.single-grant.e14.ts"
text = read(path)
text = replace_once(text, '''  input: {
    now?: Date;
    limit?: number;
  } = {}
''', '''  input: {
    now?: Date;
    limit?: number;
    deferActiveSuccessToE15?: boolean;
  } = {}
''', "E14_RECOVERY_INPUT")
text = insert_before_once(text, '''      if (
        !durableSuccess &&
        state === "AMBIGUOUS" &&
        !grant.recoveryNextAttemptAt
      ) {
''', '''      if (durableSuccess && input.deferActiveSuccessToE15) {
        if (state === "AMBIGUOUS" && !grant.recoveryNextAttemptAt) {
          ambiguous += 1;
          continue;
        }
        const updated = await db.accessGrant.updateMany({
          where: compareFenceSnapshot(grant),
          data: {
            recoveryOperation: GUEST_ACCESS_PROVISION_OPERATION.AMBIGUOUS,
            recoveryNextAttemptAt: null,
            recoveryExhaustedAt: now,
            lastError: "GUEST_ACCESS_PROVISION_AMBIGUOUS:LATE_PROVIDER_SUCCESS_REQUIRES_E15",
          },
        });
        if (updated.count === 1) ambiguous += 1;
        else races += 1;
        continue;
      }

''', "E14_ACTIVE_DEFER")
write(path, text)

path = "src/e14/guest-access-admission-safety-cycle.e14.ts"
text = read(path)
text = replace_once(text, '''  input: {
    now?: Date;
    limit?: number;
  } = {}
''', '''  input: {
    now?: Date;
    limit?: number;
    e15Enabled?: boolean;
  } = {}
''', "E14_SAFETY_INPUT")
text = replace_once(text, '''    await recoverStaleGuestAccessProvisioningFences(
      prisma,
      { now, limit }
    );
''', '''    await recoverStaleGuestAccessProvisioningFences(
      prisma,
      { now, limit, deferActiveSuccessToE15: Boolean(input.e15Enabled) }
    );
''', "E14_SAFETY_RECOVERY")
text = replace_once(text, '''          reservationId,
          { now }
        );
''', '''          reservationId,
          { now, e15Enabled: Boolean(input.e15Enabled) }
        );
''', "E14_SAFETY_MC")
write(path, text)

path = "src/e14/guest-access-readiness-mission-control.policy.e14.ts"
text = read(path)
text = replace_once(text, '''import {
  GUEST_ACCESS_PROVISION_OPERATION,
  parseGuestAccessProvisionFenceState,
} from "./guest-access-admission-fence.policy.e14.js";
''', '''import {
  GUEST_ACCESS_PROVISION_OPERATION,
  parseGuestAccessProvisionFenceState,
} from "./guest-access-admission-fence.policy.e14.js";
import {
  guestAccessE15NextAutomaticStep,
  isGuestAccessE15AutoResolvableAmbiguity,
  type GuestAccessE15MarkerState,
} from "../services/guest-access-exit-closure-a.policy.js";
''', "E14_MC_POLICY_IMPORT")
text = replace_once(text, '''    recoveryExhaustedAt: Date | null;
  }>;
''', '''    recoveryExhaustedAt: Date | null;
    e15MarkerState: GuestAccessE15MarkerState;
  }>;
''', "E14_MC_SNAPSHOT_MARKER")
text = replace_once(text, '''export function projectGuestAccessAmbiguityIssue(
  snapshot: GuestAccessMissionSnapshot,
  input: { now?: Date } = {}
): GuestAccessIssueProjection {
''', '''export function projectGuestAccessAmbiguityIssue(
  snapshot: GuestAccessMissionSnapshot,
  input: { now?: Date; e15Enabled?: boolean } = {}
): GuestAccessIssueProjection {
''', "E14_AMBIGUITY_INPUT")
text = insert_before_once(text, '''  return {
    active: true,
    operationalKey,
    issueCode: GUEST_ACCESS_AMBIGUITY_ISSUE_CODE,
    title: "Guest access execution requires reconciliation",
''', '''  const ambiguityMarkerStates = snapshot.accessGrants.filter((grant) => {
    const state = parseGuestAccessProvisionFenceState(grant.recoveryOperation);
    return grant.recoveryOperation === GUEST_ACCESS_PROVISION_OPERATION.AMBIGUOUS || state === "AMBIGUOUS" || state === "EXHAUSTED" || (state === "OTHER_OPERATION" && grant.status === "PENDING");
  }).map((grant) => grant.e15MarkerState);
  const representativeMarker = ambiguityMarkerStates.includes("MANUAL_REVIEW_REQUIRED")
    ? "MANUAL_REVIEW_REQUIRED"
    : ambiguityMarkerStates.find((value): value is Exclude<GuestAccessE15MarkerState, null> => value !== null) ?? null;
  if (isGuestAccessE15AutoResolvableAmbiguity({ e15Enabled: Boolean(input.e15Enabled), markerState: representativeMarker })) {
    return {
      active: true,
      operationalKey,
      issueCode: GUEST_ACCESS_AMBIGUITY_ISSUE_CODE,
      title: "Guest access is being reconciled automatically",
      issue: "Pin&Go fenced uncertain access execution and is reconciling it against read-only provider evidence.",
      operationalImpact: "Automatic replay remains blocked while Pin&Go verifies the existing physical credential outcome.",
      recommendedAction: null,
      nextAutomaticStep: guestAccessE15NextAutomaticStep(representativeMarker),
      severity: "WARNING",
      workflowState: "AUTO_RESOLVING",
      visibility: "SYSTEM",
      responsibleActor: "PIN_GO",
      actionRequired: false,
      canAutoResolve: true,
      autoResolveStatus: "AVAILABLE",
      metadata: { contractVersion: "guest_access_readiness_mission_control_e14_v1", reservationId: snapshot.reservationId, propertyId: snapshot.propertyId, stage: "ACCESS_EXECUTION_RECONCILIATION", e15MarkerState: representativeMarker, sanitized: true },
    };
  }

''', "E14_MC_AUTO_BLOCK")
write(path, text)

path = "src/e14/guest-access-readiness-mission-control.service.e14.ts"
text = read(path)
text = replace_once(text, '''import {
  reopenOperationalIssue,
  upsertOperationalIssue,
} from "../apms/operational-intelligence.service.js";
''', '''import {
  reopenOperationalIssue,
  upsertOperationalIssue,
} from "../apms/operational-intelligence.service.js";
import { guestAccessE15MarkerStateFromPayload } from "../services/guest-access-exit-closure-a.policy.js";
''', "E14_MC_SERVICE_IMPORT")
text = replace_once(text, '''      recoveryExhaustedAt: true,
    },
''', '''      recoveryExhaustedAt: true,
      ttlockPayload: true,
    },
''', "E14_MC_SELECT_PAYLOAD")
text = replace_once(text, '''        recoveryExhaustedAt:
          grant.recoveryExhaustedAt ?? null,
      })
''', '''        recoveryExhaustedAt:
          grant.recoveryExhaustedAt ?? null,
        e15MarkerState: guestAccessE15MarkerStateFromPayload(grant.ttlockPayload),
      })
''', "E14_MC_MAP_MARKER")
text = replace_once(text, '''  input: {
    now?: Date;
    hostActionLeadMs?: number;
  } = {}
''', '''  input: {
    now?: Date;
    hostActionLeadMs?: number;
    e15Enabled?: boolean;
  } = {}
''', "E14_MC_SERVICE_INPUT")
text = replace_once(text, '''  const ambiguity = projectGuestAccessAmbiguityIssue(
    snapshot,
    { now }
  );
''', '''  const ambiguity = projectGuestAccessAmbiguityIssue(
    snapshot,
    { now, e15Enabled: Boolean(input.e15Enabled) }
  );
''', "E14_MC_SERVICE_PROJECT")
write(path, text)

path = "src/services/guest-journey-access-owner-mission-control.service.ts"
text = read(path)
text = replace_once(text, '''import { upsertOperationalIssue } from "../apms/operational-intelligence.service";
''', '''import { upsertOperationalIssue } from "../apms/operational-intelligence.service";
import { guestAccessE15MarkerStateFromPayload, guestAccessE15NextAutomaticStep, isGuestAccessE15AutoResolvableOwnerExhaustion } from "./guest-access-exit-closure-a.policy";
''', "ACCESS_MC_IMPORT")
text = replace_once(text, '''  expectedScope: { organizationId: string; propertyId: string },
''', '''  expectedScope: { organizationId: string; propertyId: string; e15Enabled?: boolean },
''', "ACCESS_MC_SCOPE_TYPE")
text = replace_once(text, '''          propertyId: true,
          property: { select: { organizationId: true } },
''', '''          propertyId: true,
          property: { select: { organizationId: true } },
          accessGrants: { where: { type: "GUEST", method: "PASSCODE_TIMEBOUND" }, select: { recoveryOperation: true, ttlockPayload: true } },
''', "ACCESS_MC_GRANTS_SELECT")
text = insert_before_once(text, '''  if (
    existing?.workflowState === "ACTION_REQUIRED" &&
    existing.lastSignalAt.getTime() >= intent.updatedAt.getTime()
  ) {
''', '''  const e15ManualReview = intent.reservation.accessGrants.some((grant) => guestAccessE15MarkerStateFromPayload(grant.ttlockPayload) === "MANUAL_REVIEW_REQUIRED");
  const e15AutoResolvable = !e15ManualReview && isGuestAccessE15AutoResolvableOwnerExhaustion({ e15Enabled: Boolean(expectedScope.e15Enabled), intentType: intent.intentType, lastError: intent.lastError });
  if (e15AutoResolvable) {
    if (existing?.workflowState === "AUTO_RESOLVING" && existing.lastSignalAt.getTime() >= intent.updatedAt.getTime()) {
      return { action: "UNCHANGED", operationalIssueWrites: 0, externalSideEffects: 0 };
    }
    const occurredAt = intent.exhaustedAt ?? intent.updatedAt;
    const markerState = intent.reservation.accessGrants.map((grant) => guestAccessE15MarkerStateFromPayload(grant.ttlockPayload)).find((state) => state !== null) ?? null;
    await dependencies.upsert(prisma, {
      operationalKey,
      issueCode: ISSUE_CODE,
      title: "Guest access owner is reconciling uncertain execution",
      issue: "The ACCESS owner stopped replay and delegated the ambiguous provisioning outcome to E15 reconciliation.",
      operationalImpact: "Pin&Go is verifying the existing physical credential before any controlled rearm.",
      recommendedAction: null,
      nextAutomaticStep: guestAccessE15NextAutomaticStep(markerState),
      engine: "GUEST_JOURNEY",
      severity: "WARNING",
      workflowState: "AUTO_RESOLVING",
      visibility: "SYSTEM",
      responsibleActor: "PIN_GO",
      actionRequired: false,
      canAutoResolve: true,
      autoResolveStatus: "AVAILABLE",
      autoResolveActionCode: null,
      organizationId: expectedScope.organizationId,
      propertyId: expectedScope.propertyId,
      reservationId: intent.reservationId,
      reservationNumber: intent.reservation.reservationNumber,
      guestName: intent.reservation.guestName,
      sourceType: "ENGINE_EVENT",
      firstDetectedAt: existing?.firstDetectedAt ?? occurredAt,
      lastSignalAt: intent.updatedAt,
      resolvedAt: null,
      resolutionCode: null,
      resolutionSummary: null,
      resolutionType: null,
      resolvedBy: null,
      actionTarget: "ACCESS",
      metadata: { intentId: intent.id, intentType: intent.intentType, status: intent.status, claimCount: intent.claimCount, errorCode: intent.lastError, e15MarkerState: markerState },
      transitionCode: "GUEST_JOURNEY_ACCESS_OWNER_E15_RECONCILIATION",
      transitionSummary: "The ACCESS owner delegated ambiguous provisioning to E15 without replay.",
      transitionedBy: "PIN_GO",
      occurredAt,
    });
    return { action: existing ? "UPDATED" : "CREATED", operationalIssueWrites: 1, externalSideEffects: 0 };
  }

''', "ACCESS_MC_AUTO_BRANCH")
write(path, text)

path = "src/services/guest-journey-access-owner-cycle.service.ts"
text = read(path)
text = replace_once(text, '''  options: {
    now?: Date;
    logger?: (entry: {
''', '''  options: {
    now?: Date;
    e15Enabled?: boolean;
    logger?: (entry: {
''', "ACCESS_CYCLE_OPTIONS")
text = replace_once(text, '''              organizationId: candidate.reservation.property.organizationId,
              propertyId: candidate.reservation.propertyId,
            }
''', '''              organizationId: candidate.reservation.property.organizationId,
              propertyId: candidate.reservation.propertyId,
              e15Enabled: Boolean(options.e15Enabled),
            }
''', "ACCESS_CYCLE_MC_CLAIM")
text = replace_once(text, '''          organizationId: claimed.claim.organizationId,
          propertyId: claimed.claim.propertyId,
        }
''', '''          organizationId: claimed.claim.organizationId,
          propertyId: claimed.claim.propertyId,
          e15Enabled: Boolean(options.e15Enabled),
        }
''', "ACCESS_CYCLE_MC_COMPLETE")
write(path, text)

path = "src/workers/reservation.worker.ts"
text = read(path)
text = replace_once(text, '''          await runGuestAccessAdmissionSafetyCycle(
            prisma,
            { now }
          );
''', '''          await runGuestAccessAdmissionSafetyCycle(
            prisma,
            { now, e15Enabled: GUEST_ACCESS_AMBIGUITY_E15_CONFIG.enabled }
          );
''', "WORKER_E14_SAFETY")
text = replace_once(text, '''            await runGuestJourneyAccessOwnerCycle(
              prisma,
              GUEST_JOURNEY_ACCESS_OWNER_CONFIG,
              { now }
            );
''', '''            await runGuestJourneyAccessOwnerCycle(
              prisma,
              GUEST_JOURNEY_ACCESS_OWNER_CONFIG,
              { now, e15Enabled: GUEST_ACCESS_AMBIGUITY_E15_CONFIG.enabled }
            );
''', "WORKER_ACCESS_OWNER")
write(path, text)

path = "src/e15/guest-access-ambiguity-reconciliation.e15.ts"
text = read(path)
text = replace_once(text, '''import {
  assertGuestJourneyTenantPropertyScope,
''', '''import { decideGuestAccessE15Reconciliation } from "../services/guest-access-exit-closure-a.policy";
import {
  assertGuestJourneyTenantPropertyScope,
''', "E15_POLICY_IMPORT")
text = replace_once(text, '''  adoptProviderCredentialUnderReservationFenceE15_1,
  rearmAmbiguousGrantUnderReservationFenceE15_1,
''', '''  adoptProviderCredentialUnderReservationFenceE15_1,
  reconcileLateProviderSuccessUnderReservationFenceE15_1,
  rearmAmbiguousGrantUnderReservationFenceE15_1,
''', "E15_LATE_IMPORT")
text = replace_once(text, '''      status: AccessStatus.PENDING,
      recoveryOperation: GUEST_ACCESS_PROVISION_OPERATION.AMBIGUOUS,
''', '''      status: { in: [AccessStatus.PENDING, AccessStatus.ACTIVE] },
      recoveryOperation: GUEST_ACCESS_PROVISION_OPERATION.AMBIGUOUS,
''', "E15_QUERY_STATUS")
text = replace_once(text, '''      lastError: true,
      ttlockPayload: true,
      lock: { select: { ttlockLockId: true } },
''', '''      lastError: true,
      ttlockPayload: true,
      ttlockKeyboardPwdId: true,
      secureAccessCode: { select: { id: true } },
      lock: { select: { ttlockLockId: true } },
''', "E15_SELECT_LOCAL_EVIDENCE")
text = insert_before_once(text, '''    if (classification.kind === "INCOMPLETE" || classification.kind === "CONFLICT") {
''', '''    if (grant.status === AccessStatus.ACTIVE) {
      const decision = decideGuestAccessE15Reconciliation({ grantStatus: "ACTIVE", recoveryOperation: grant.recoveryOperation, localKeyboardPwdId: grant.ttlockKeyboardPwdId ? Number(grant.ttlockKeyboardPwdId) : null, secureCodePresent: Boolean(grant.secureAccessCode), provider: classification.kind === "EXACT_MATCH" ? { kind: "EXACT_MATCH", keyboardPwdId: classification.item.keyboardPwdId } : { kind: classification.kind } });
      if (decision === "VERIFY_PROVIDER_STATE") {
        const marker: E15Marker = { version: GUEST_ACCESS_AMBIGUITY_E15_VERSION, state: "VERIFYING_PROVIDER_STATE", inventoryFingerprint: inventory.fingerprint, observedAt: now.toISOString(), reason: classification.kind === "INCOMPLETE" ? classification.reason : "ACTIVE_PROVIDER_STATE_REQUIRES_VERIFICATION" };
        const updated = await prisma.accessGrant.updateMany({ where: { id: grant.id, status: AccessStatus.ACTIVE, recoveryOperation: GUEST_ACCESS_PROVISION_OPERATION.AMBIGUOUS, recoveryAttemptCount: grant.recoveryAttemptCount, updatedAt: grant.updatedAt }, data: { ttlockPayload: withMarker(grant.ttlockPayload, marker) } });
        if (updated.count !== 1) metrics.races += 1;
        continue;
      }
      if (decision === "RECONCILE_LATE_SUCCESS" && classification.kind === "EXACT_MATCH") {
        const payload = withMarker(grant.ttlockPayload, { version: GUEST_ACCESS_AMBIGUITY_E15_VERSION, state: "RECONCILED_PRESENT", inventoryFingerprint: inventory.fingerprint, observedAt: now.toISOString(), reason: "LATE_PROVIDER_SUCCESS_VERIFIED" });
        let reconciled = false;
        try {
          reconciled = await reconcileLateProviderSuccessUnderReservationFenceE15_1(prisma, { grantId: grant.id, reservationId: reservation.id, organizationId, propertyId: reservation.propertyId, startsAt: grant.startsAt, endsAt: grant.endsAt, updatedAt: grant.updatedAt, recoveryAttemptCount: grant.recoveryAttemptCount, ttlockLockId, now, keyboardPwdId: classification.item.keyboardPwdId, payload });
        } catch { metrics.races += 1; continue; }
        if (reconciled) metrics.reconciledPresent += 1;
        else metrics.races += 1;
        continue;
      }
      const marker: E15Marker = { version: GUEST_ACCESS_AMBIGUITY_E15_VERSION, state: "MANUAL_REVIEW_REQUIRED", inventoryFingerprint: inventory.fingerprint, observedAt: now.toISOString(), reason: classification.kind === "CONFLICT" ? classification.reason : `ACTIVE_LOCAL_PROVIDER_CONFLICT:${classification.kind}` };
      const updated = await prisma.accessGrant.updateMany({ where: { id: grant.id, status: AccessStatus.ACTIVE, recoveryOperation: GUEST_ACCESS_PROVISION_OPERATION.AMBIGUOUS, recoveryAttemptCount: grant.recoveryAttemptCount, updatedAt: grant.updatedAt }, data: { ttlockPayload: withMarker(grant.ttlockPayload, marker) } });
      if (updated.count !== 1) metrics.races += 1;
      else metrics.manualReview += 1;
      continue;
    }

''', "E15_ACTIVE_BLOCK")
write(path, text)

path = "src/e15/guest-access-reservation-reconciliation-fence.e15-1.ts"
text = read(path)
text = replace_once(text, '''export type RearmAmbiguousGrantE15_1Input = ExpectedGrantSnapshot & {
  now: Date;
  payload: Prisma.InputJsonValue;
};
''', '''export type RearmAmbiguousGrantE15_1Input = ExpectedGrantSnapshot & {
  now: Date;
  payload: Prisma.InputJsonValue;
};

export type ReconcileLateProviderSuccessE15_1Input = ExpectedGrantSnapshot & { now: Date; keyboardPwdId: number; payload: Prisma.InputJsonValue; };
export type QuarantineActiveProviderOutcomeE15_1Input = { grantId: string; reservationId: string; organizationId: string; propertyId: string; startsAt: Date; endsAt: Date; ttlockLockId: number; now: Date; reason: string; };
''', "E15_1_TYPES")
text = insert_before_once(text, '''async function withReservationFence<T>(
''', '''function findCanonicalActiveTarget(reservation: ReservationFenceSnapshot, input: ReconcileLateProviderSuccessE15_1Input): ReservationFenceGrant | null {
  const canonical = reservation.accessGrants.filter((grant) => grant.status === AccessStatus.ACTIVE && sameInstant(grant.startsAt, reservation.checkIn) && sameInstant(grant.endsAt, reservation.checkOut));
  if (canonical.length !== 1 || canonical[0].id !== input.grantId) return null;
  const target = canonical[0];
  if (target.recoveryOperation !== GUEST_ACCESS_PROVISION_OPERATION.AMBIGUOUS || target.recoveryAttemptCount !== input.recoveryAttemptCount || !sameInstant(target.updatedAt, input.updatedAt) || !sameInstant(target.startsAt, input.startsAt) || !sameInstant(target.endsAt, input.endsAt) || positiveTtlockLockId(target) !== input.ttlockLockId || Number(target.ttlockKeyboardPwdId) !== input.keyboardPwdId || !target.secureAccessCode) return null;
  for (const sibling of reservation.accessGrants) { if (sibling.id !== target.id && isBlockingSibling(sibling)) return null; }
  return target;
}

''', "E15_1_ACTIVE_TARGET")
text = insert_before_once(text, '''export async function rearmAmbiguousGrantUnderReservationFenceE15_1(
''', '''export async function reconcileLateProviderSuccessUnderReservationFenceE15_1(prisma: PrismaClient, input: ReconcileLateProviderSuccessE15_1Input): Promise<boolean> {
  const result = await withReservationFence(prisma, input.reservationId, async (tx, reservation) => {
    if (!lifecycleMatches(reservation, { organizationId: input.organizationId, propertyId: input.propertyId, now: input.now, releaseStatus: GuestAccessReleaseStatus.ELIGIBLE })) return false;
    const target = findCanonicalActiveTarget(reservation, input);
    if (!target) return false;
    const updated = await tx.accessGrant.updateMany({ where: { id: target.id, reservationId: reservation.id, status: AccessStatus.ACTIVE, recoveryOperation: GUEST_ACCESS_PROVISION_OPERATION.AMBIGUOUS, recoveryAttemptCount: input.recoveryAttemptCount, updatedAt: input.updatedAt, startsAt: reservation.checkIn, endsAt: reservation.checkOut, ttlockKeyboardPwdId: input.keyboardPwdId }, data: { recoveryOperation: null, recoveryAttemptCount: 0, recoveryLastAttemptAt: null, recoveryNextAttemptAt: null, recoveryExhaustedAt: null, lastError: null, ttlockPayload: input.payload } });
    if (updated.count !== 1) return false;
    const released = await tx.reservation.updateMany({ where: { id: reservation.id, propertyId: input.propertyId, status: ReservationStatus.ACTIVE, paymentState: PaymentState.PAID, guestAccessReleaseStatus: GuestAccessReleaseStatus.ELIGIBLE, checkIn: reservation.checkIn, checkOut: reservation.checkOut }, data: { guestAccessReleaseStatus: GuestAccessReleaseStatus.RELEASED, guestAccessReleasedAt: input.now, guestAccessReleaseLastError: null } });
    if (released.count !== 1) throw new Error("GUEST_ACCESS_EXIT_CLOSURE_A_LATE_SUCCESS_RELEASE_CAS_LOST");
    return true;
  });
  return result === true;
}

export async function quarantineActiveProviderOutcomeUnderReservationFenceE15_1(prisma: PrismaClient, input: QuarantineActiveProviderOutcomeE15_1Input): Promise<boolean> {
  const result = await withReservationFence(prisma, input.reservationId, async (tx, reservation) => {
    if (reservation.property.organizationId !== input.organizationId || reservation.propertyId !== input.propertyId) return false;
    const target = reservation.accessGrants.find((grant) => grant.id === input.grantId);
    if (!target || target.status !== AccessStatus.ACTIVE || !sameInstant(target.startsAt, input.startsAt) || !sameInstant(target.endsAt, input.endsAt) || positiveTtlockLockId(target) !== input.ttlockLockId || !target.ttlockKeyboardPwdId || !target.secureAccessCode) return false;
    const updated = await tx.accessGrant.updateMany({ where: { id: target.id, reservationId: reservation.id, status: AccessStatus.ACTIVE, startsAt: input.startsAt, endsAt: input.endsAt, recoveryOperation: target.recoveryOperation, recoveryAttemptCount: target.recoveryAttemptCount, updatedAt: target.updatedAt }, data: { recoveryOperation: GUEST_ACCESS_PROVISION_OPERATION.AMBIGUOUS, recoveryNextAttemptAt: null, recoveryExhaustedAt: input.now, lastError: input.reason } });
    return updated.count === 1;
  });
  return result === true;
}

''', "E15_1_FUNCTIONS")
write(path, text)

path = "src/e15/guest-access-reservation-reconciliation-fence.e15-1.test.ts"
text = read(path)
text = replace_once(text, '''  adoptProviderCredentialUnderReservationFenceE15_1,
  rearmAmbiguousGrantUnderReservationFenceE15_1,
''', '''  adoptProviderCredentialUnderReservationFenceE15_1,
  quarantineActiveProviderOutcomeUnderReservationFenceE15_1,
  reconcileLateProviderSuccessUnderReservationFenceE15_1,
  rearmAmbiguousGrantUnderReservationFenceE15_1,
''', "E15_1_TEST_IMPORT")
if "Closure A reconciles verified late provider success" not in text:
    text += '''\n\ntest("Closure A reconciles verified late provider success under the reservation fence", async () => {
  const db = buildDb({ reservation: reservation({ accessGrants: [grant({ status: AccessStatus.ACTIVE, ttlockKeyboardPwdId: 5001, secureAccessCode: { id: "code1" } })] }) });
  assert.equal(await reconcileLateProviderSuccessUnderReservationFenceE15_1(db.prisma, { grantId: "g1", reservationId: "r1", organizationId: "o1", propertyId: "p1", startsAt: checkIn, endsAt: checkOut, updatedAt, recoveryAttemptCount: 2, ttlockLockId: 101, now, keyboardPwdId: 5001, payload: marker("RECONCILED_PRESENT") }), true);
  assert.ok(db.calls.indexOf("LOCK_RESERVATION") < db.calls.indexOf("LOCK_GRANTS"));
  assert.ok(db.calls.indexOf("UPDATE_GRANT") < db.calls.indexOf("UPDATE_RESERVATION"));
  assert.equal(db.calls.includes("UPSERT_ACCESS_CODE"), false);
});

test("Closure A refuses late success when provider id disagrees with durable local evidence", async () => {
  const db = buildDb({ reservation: reservation({ accessGrants: [grant({ status: AccessStatus.ACTIVE, ttlockKeyboardPwdId: 5001, secureAccessCode: { id: "code1" } })] }) });
  assert.equal(await reconcileLateProviderSuccessUnderReservationFenceE15_1(db.prisma, { grantId: "g1", reservationId: "r1", organizationId: "o1", propertyId: "p1", startsAt: checkIn, endsAt: checkOut, updatedAt, recoveryAttemptCount: 2, ttlockLockId: 101, now, keyboardPwdId: 9009, payload: marker("RECONCILED_PRESENT") }), false);
  assert.equal(db.calls.includes("UPDATE_RESERVATION"), false);
});

test("Closure A quarantines active provider evidence after owner release CAS loss", async () => {
  const db = buildDb({ reservation: reservation({ accessGrants: [grant({ status: AccessStatus.ACTIVE, recoveryOperation: null, recoveryAttemptCount: 0, ttlockKeyboardPwdId: 5001, secureAccessCode: { id: "code1" } })] }) });
  assert.equal(await quarantineActiveProviderOutcomeUnderReservationFenceE15_1(db.prisma, { grantId: "g1", reservationId: "r1", organizationId: "o1", propertyId: "p1", startsAt: checkIn, endsAt: checkOut, ttlockLockId: 101, now, reason: "GUEST_ACCESS_PROVISION_AMBIGUOUS:OWNER_RELEASE_PERSISTENCE_FENCE_LOST" }), true);
  assert.equal(db.calls.includes("UPDATE_GRANT"), true);
  assert.equal(db.calls.includes("UPDATE_RESERVATION"), false);
});\n'''
write(path, text)

print("APMS_EXIT_CLOSURE_A_PATCH_APPLIED")
