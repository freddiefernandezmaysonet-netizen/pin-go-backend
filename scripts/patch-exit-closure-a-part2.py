from pathlib import Path


def replace_once(path: str, old: str, new: str, code: str) -> None:
    p = Path(path)
    text = p.read_text(encoding='utf-8')
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{code}: expected 1 anchor, found {count}')
    p.write_text(text.replace(old, new, 1), encoding='utf-8')


def insert_after(path: str, anchor: str, addition: str, code: str) -> None:
    replace_once(path, anchor, anchor + addition, code)

# ---------------------------------------------------------------------------
# E15 accepts both PENDING and ACTIVE ambiguous grants; ACTIVE is late success
# only when read-only provider evidence matches durable local evidence.
# ---------------------------------------------------------------------------
e15 = 'src/e15/guest-access-ambiguity-reconciliation.e15.ts'
insert_after(
    e15,
    'import {\n  GUEST_ACCESS_PROVISION_OPERATION,\n} from "../e14/guest-access-admission-fence.policy.e14";\n',
    'import {\n  decideGuestAccessE15Reconciliation,\n} from "../services/guest-access-exit-closure-a.policy";\n'
    'import {\n  syncGuestJourneyAccessOwnerMissionControl,\n} from "../services/guest-journey-access-owner-mission-control.service";\n',
    'EXIT_A_E15_IMPORT_POLICY_ANCHOR',
)
replace_once(
    e15,
    '  adoptProviderCredentialUnderReservationFenceE15_1,\n  rearmAmbiguousGrantUnderReservationFenceE15_1,\n',
    '  adoptProviderCredentialUnderReservationFenceE15_1,\n  reconcileLateProviderSuccessUnderReservationFenceE15_1,\n  rearmAmbiguousGrantUnderReservationFenceE15_1,\n',
    'EXIT_A_E15_IMPORT_HELPER_ANCHOR',
)
replace_once(
    e15,
    '    where: {\n      type: "GUEST",\n      method: AccessMethod.PASSCODE_TIMEBOUND,\n      status: AccessStatus.PENDING,\n      recoveryOperation: GUEST_ACCESS_PROVISION_OPERATION.AMBIGUOUS,\n',
    '    where: {\n      type: "GUEST",\n      method: AccessMethod.PASSCODE_TIMEBOUND,\n      status: { in: [AccessStatus.PENDING, AccessStatus.ACTIVE] },\n      recoveryOperation: GUEST_ACCESS_PROVISION_OPERATION.AMBIGUOUS,\n',
    'EXIT_A_E15_SELECTOR_STATUS_ANCHOR',
)
replace_once(
    e15,
    '      ttlockPayload: true,\n      lock: { select: { ttlockLockId: true } },\n',
    '      ttlockPayload: true,\n      ttlockKeyboardPwdId: true,\n      secureAccessCode: { select: { id: true } },\n      lock: { select: { ttlockLockId: true } },\n',
    'EXIT_A_E15_SELECTOR_EVIDENCE_ANCHOR',
)
start = '    if (classification.kind === "INCOMPLETE" || classification.kind === "CONFLICT") {'
end = '    const absence = nextAbsenceMarker({\n'
p = Path(e15)
text = p.read_text(encoding='utf-8')
si = text.find(start)
ei = text.find(end, si)
if si < 0 or ei < 0:
    raise SystemExit('EXIT_A_E15_DECISION_BLOCK_ANCHOR')
new_block = '''    const providerDecision =\n      classification.kind === "EXACT_MATCH"\n        ? {\n            kind: "EXACT_MATCH" as const,\n            keyboardPwdId: classification.item.keyboardPwdId,\n          }\n        : classification.kind === "ABSENT"\n          ? { kind: "ABSENT" as const }\n          : classification.kind === "INCOMPLETE"\n            ? { kind: "INCOMPLETE" as const }\n            : { kind: "CONFLICT" as const };\n    const reconciliationDecision =\n      decideGuestAccessE15Reconciliation({\n        grantStatus:\n          grant.status === AccessStatus.ACTIVE\n            ? "ACTIVE"\n            : "PENDING",\n        recoveryOperation: grant.recoveryOperation,\n        localKeyboardPwdId: grant.ttlockKeyboardPwdId\n          ? Number(grant.ttlockKeyboardPwdId)\n          : null,\n        secureCodePresent: Boolean(grant.secureAccessCode),\n        provider: providerDecision,\n      });\n\n    const persistMarker = async (marker: E15Marker) =>\n      prisma.accessGrant.updateMany({\n        where: {\n          id: grant.id,\n          status: grant.status,\n          recoveryOperation: GUEST_ACCESS_PROVISION_OPERATION.AMBIGUOUS,\n          recoveryAttemptCount: grant.recoveryAttemptCount,\n          updatedAt: grant.updatedAt,\n        },\n        data: {\n          ttlockPayload: withMarker(grant.ttlockPayload, marker),\n        },\n      });\n\n    if (reconciliationDecision === "VERIFY_PROVIDER_STATE") {\n      const updated = await persistMarker({\n        version: GUEST_ACCESS_AMBIGUITY_E15_VERSION,\n        state: "VERIFYING_PROVIDER_STATE",\n        inventoryFingerprint: inventory.fingerprint,\n        observedAt: now.toISOString(),\n        reason:\n          classification.kind === "INCOMPLETE"\n            ? classification.reason\n            : "PROVIDER_INVENTORY_INCOMPLETE",\n      });\n      if (updated.count !== 1) metrics.races += 1;\n      continue;\n    }\n\n    if (reconciliationDecision === "MANUAL_REVIEW_REQUIRED") {\n      const reason =\n        classification.kind === "CONFLICT"\n          ? classification.reason\n          : grant.status === AccessStatus.ACTIVE &&\n              classification.kind === "ABSENT"\n            ? "ACTIVE_LOCAL_CREDENTIAL_ABSENT_AT_PROVIDER"\n            : grant.status === AccessStatus.ACTIVE &&\n                classification.kind === "EXACT_MATCH" &&\n                Number(grant.ttlockKeyboardPwdId) !==\n                  classification.item.keyboardPwdId\n              ? "ACTIVE_PROVIDER_CREDENTIAL_ID_MISMATCH"\n              : "ACTIVE_LOCAL_CREDENTIAL_EVIDENCE_INCOMPLETE";\n      const updated = await persistMarker({\n        version: GUEST_ACCESS_AMBIGUITY_E15_VERSION,\n        state: "MANUAL_REVIEW_REQUIRED",\n        inventoryFingerprint: inventory.fingerprint,\n        observedAt: now.toISOString(),\n        reason,\n      });\n      if (updated.count !== 1) metrics.races += 1;\n      else metrics.manualReview += 1;\n      continue;\n    }\n\n    if (\n      reconciliationDecision === "RECONCILE_LATE_SUCCESS" &&\n      classification.kind === "EXACT_MATCH"\n    ) {\n      const payload = withMarker(grant.ttlockPayload, {\n        version: GUEST_ACCESS_AMBIGUITY_E15_VERSION,\n        state: "RECONCILED_PRESENT",\n        inventoryFingerprint: inventory.fingerprint,\n        observedAt: now.toISOString(),\n        reason: "LATE_PROVIDER_SUCCESS_MATCHED_DURABLE_EVIDENCE",\n      });\n      let reconciled = false;\n      try {\n        reconciled =\n          await reconcileLateProviderSuccessUnderReservationFenceE15_1(\n            prisma,\n            {\n              grantId: grant.id,\n              reservationId: reservation.id,\n              organizationId,\n              propertyId: reservation.propertyId,\n              startsAt: grant.startsAt,\n              endsAt: grant.endsAt,\n              updatedAt: grant.updatedAt,\n              recoveryAttemptCount: grant.recoveryAttemptCount,\n              ttlockLockId,\n              now,\n              providerKeyboardPwdId: classification.item.keyboardPwdId,\n              payload,\n            }\n          );\n      } catch {\n        metrics.races += 1;\n        continue;\n      }\n      if (reconciled) metrics.reconciledPresent += 1;\n      else metrics.races += 1;\n      continue;\n    }\n\n    if (\n      reconciliationDecision === "ADOPT_PROVIDER_PRESENT" &&\n      classification.kind === "EXACT_MATCH"\n    ) {\n      const item = classification.item;\n      const code = item.keyboardPwd.trim();\n      const encrypted = encryptAccessCode(code);\n      const hashed = hashAccessCode(code);\n      const masked = maskCode(code);\n      const payload = withMarker(grant.ttlockPayload, {\n        version: GUEST_ACCESS_AMBIGUITY_E15_VERSION,\n        state: "RECONCILED_PRESENT",\n        inventoryFingerprint: inventory.fingerprint,\n        observedAt: now.toISOString(),\n      });\n\n      let adopted = false;\n      try {\n        adopted =\n          await adoptProviderCredentialUnderReservationFenceE15_1(\n            prisma,\n            {\n              grantId: grant.id,\n              reservationId: reservation.id,\n              organizationId,\n              propertyId: reservation.propertyId,\n              startsAt: grant.startsAt,\n              endsAt: grant.endsAt,\n              updatedAt: grant.updatedAt,\n              recoveryAttemptCount: grant.recoveryAttemptCount,\n              ttlockLockId,\n              now,\n              keyboardPwdId: item.keyboardPwdId,\n              code,\n              maskedCode: masked,\n              encryptedCode: encrypted,\n              hashedCode: hashed,\n              payload,\n              guestPhone: reservation.guestPhone ?? null,\n            }\n          );\n      } catch {\n        metrics.races += 1;\n        continue;\n      }\n      if (adopted) metrics.reconciledPresent += 1;\n      else metrics.races += 1;\n      continue;\n    }\n\n'''
p.write_text(text[:si] + new_block + text[ei:], encoding='utf-8')
text = p.read_text(encoding='utf-8')
text = text.replace(
    '          status: AccessStatus.PENDING,\n          recoveryOperation: GUEST_ACCESS_PROVISION_OPERATION.AMBIGUOUS,\n          recoveryAttemptCount: grant.recoveryAttemptCount,\n          updatedAt: grant.updatedAt,\n        },\n        data: { ttlockPayload: withMarker(grant.ttlockPayload, absence) },\n',
    '          status: grant.status,\n          recoveryOperation: GUEST_ACCESS_PROVISION_OPERATION.AMBIGUOUS,\n          recoveryAttemptCount: grant.recoveryAttemptCount,\n          updatedAt: grant.updatedAt,\n        },\n        data: { ttlockPayload: withMarker(grant.ttlockPayload, absence) },\n',
)
p.write_text(text, encoding='utf-8')
old_intent_tail = '''    if (reconciliation.action === "SUCCEEDED") {\n      metrics.reconciledIntents += 1;\n    } else if (reconciliation.action === "REARMED") {\n      metrics.rearmedIntents += 1;\n    }\n'''
new_intent_tail = '''    if (reconciliation.action === "SUCCEEDED") {\n      metrics.reconciledIntents += 1;\n    } else if (reconciliation.action === "REARMED") {\n      metrics.rearmedIntents += 1;\n    }\n\n    if (reconciliation.action !== "UNCHANGED") {\n      try {\n        await syncGuestJourneyAccessOwnerMissionControl(\n          prisma,\n          intent.id,\n          {\n            organizationId:\n              intent.reservation.property.organizationId,\n            propertyId: intent.reservation.propertyId,\n            e15Enabled: input.config.enabled,\n          }\n        );\n      } catch {\n        metrics.races += 1;\n      }\n    }\n'''
replace_once(e15, old_intent_tail, new_intent_tail, 'EXIT_A_E15_INTENT_MC_ANCHOR')

# ---------------------------------------------------------------------------
# E14 Mission Control becomes E15-aware while preserving default fail-closed.
# ---------------------------------------------------------------------------
e14_policy = 'src/e14/guest-access-readiness-mission-control.policy.e14.ts'
insert_after(
    e14_policy,
    'import {\n  GUEST_ACCESS_PROVISION_OPERATION,\n  parseGuestAccessProvisionFenceState,\n} from "./guest-access-admission-fence.policy.e14.js";\n',
    'import {\n  guestAccessE15NextAutomaticStep,\n  isGuestAccessE15AutoResolvableAmbiguity,\n  type GuestAccessE15MarkerState,\n} from "../services/guest-access-exit-closure-a.policy.js";\n',
    'EXIT_A_E14_POLICY_IMPORT_ANCHOR',
)
replace_once(
    e14_policy,
    '    recoveryExhaustedAt: Date | null;\n  }>;\n};\n',
    '    recoveryExhaustedAt: Date | null;\n    e15MarkerState?: GuestAccessE15MarkerState;\n  }>;\n};\n',
    'EXIT_A_E14_POLICY_SNAPSHOT_ANCHOR',
)
replace_once(
    e14_policy,
    'export function projectGuestAccessAmbiguityIssue(\n  snapshot: GuestAccessMissionSnapshot,\n  input: { now?: Date } = {}\n): GuestAccessIssueProjection {\n',
    'export function projectGuestAccessAmbiguityIssue(\n  snapshot: GuestAccessMissionSnapshot,\n  input: { now?: Date; e15Enabled?: boolean } = {}\n): GuestAccessIssueProjection {\n',
    'EXIT_A_E14_POLICY_INPUT_ANCHOR',
)
old_review = '''  const reviewRequired = snapshot.accessGrants.some(\n    (grant) => {\n      const state =\n        parseGuestAccessProvisionFenceState(\n          grant.recoveryOperation\n        );\n\n      return (\n        grant.recoveryOperation ===\n          GUEST_ACCESS_PROVISION_OPERATION.AMBIGUOUS ||\n        state === "AMBIGUOUS" ||\n        state === "EXHAUSTED" ||\n        (state === "OTHER_OPERATION" &&\n          grant.status === "PENDING")\n      );\n    }\n  );\n'''
new_review = '''  const reviewGrants = snapshot.accessGrants.filter(\n    (grant) => {\n      const state =\n        parseGuestAccessProvisionFenceState(\n          grant.recoveryOperation\n        );\n\n      return (\n        grant.recoveryOperation ===\n          GUEST_ACCESS_PROVISION_OPERATION.AMBIGUOUS ||\n        state === "AMBIGUOUS" ||\n        state === "EXHAUSTED" ||\n        (state === "OTHER_OPERATION" &&\n          grant.status === "PENDING")\n      );\n    }\n  );\n  const reviewRequired = reviewGrants.length > 0;\n'''
replace_once(e14_policy, old_review, new_review, 'EXIT_A_E14_POLICY_REVIEW_ANCHOR')
critical_anchor = '''  return {\n    active: true,\n    operationalKey,\n    issueCode: GUEST_ACCESS_AMBIGUITY_ISSUE_CODE,\n    title: "Guest access execution requires reconciliation",\n'''
auto_block = '''  const markerStates = reviewGrants.map(\n    (grant) => grant.e15MarkerState ?? null\n  );\n  const markerState =\n    markerStates.find((state) => state === "MANUAL_REVIEW_REQUIRED") ??\n    markerStates.find(Boolean) ??\n    null;\n  if (\n    isGuestAccessE15AutoResolvableAmbiguity({\n      e15Enabled: input.e15Enabled === true,\n      markerState,\n    })\n  ) {\n    return {\n      active: true,\n      operationalKey,\n      issueCode: GUEST_ACCESS_AMBIGUITY_ISSUE_CODE,\n      title: "Guest access is being reconciled automatically",\n      issue:\n        "Pin&Go fenced the uncertain access outcome and is reconciling read-only provider evidence.",\n      operationalImpact:\n        "Automatic replay remains blocked while Pin&Go verifies the current credential state.",\n      recommendedAction: null,\n      nextAutomaticStep:\n        guestAccessE15NextAutomaticStep(markerState),\n      severity: "WARNING",\n      workflowState: "AUTO_RESOLVING",\n      visibility: "SYSTEM",\n      responsibleActor: "PIN_GO",\n      actionRequired: false,\n      canAutoResolve: true,\n      autoResolveStatus: "AVAILABLE",\n      metadata: {\n        contractVersion:\n          "guest_access_readiness_mission_control_e14_v1",\n        reservationId: snapshot.reservationId,\n        propertyId: snapshot.propertyId,\n        stage: "ACCESS_EXECUTION_RECONCILIATION",\n        e15MarkerState: markerState,\n        sanitized: true,\n      },\n    };\n  }\n\n'''
replace_once(e14_policy, critical_anchor, auto_block + critical_anchor, 'EXIT_A_E14_POLICY_AUTO_ANCHOR')

e14_mc = 'src/e14/guest-access-readiness-mission-control.service.e14.ts'
insert_after(
    e14_mc,
    'import {\n  reopenOperationalIssue,\n  upsertOperationalIssue,\n} from "../apms/operational-intelligence.service.js";\n',
    'import {\n  guestAccessE15MarkerStateFromPayload,\n} from "../services/guest-access-exit-closure-a.policy.js";\n',
    'EXIT_A_E14_MC_IMPORT_ANCHOR',
)
replace_once(
    e14_mc,
    '      recoveryExhaustedAt: true,\n    },\n',
    '      recoveryExhaustedAt: true,\n      ttlockPayload: true,\n    },\n',
    'EXIT_A_E14_MC_SELECT_ANCHOR',
)
replace_once(
    e14_mc,
    '        recoveryExhaustedAt:\n          grant.recoveryExhaustedAt ?? null,\n      })\n',
    '        recoveryExhaustedAt:\n          grant.recoveryExhaustedAt ?? null,\n        e15MarkerState:\n          guestAccessE15MarkerStateFromPayload(\n            grant.ttlockPayload\n          ),\n      })\n',
    'EXIT_A_E14_MC_SNAPSHOT_ANCHOR',
)
replace_once(
    e14_mc,
    '  input: {\n    now?: Date;\n    hostActionLeadMs?: number;\n  } = {}\n',
    '  input: {\n    now?: Date;\n    hostActionLeadMs?: number;\n    e15Enabled?: boolean;\n  } = {}\n',
    'EXIT_A_E14_MC_INPUT_ANCHOR',
)
replace_once(
    e14_mc,
    '  const ambiguity = projectGuestAccessAmbiguityIssue(\n    snapshot,\n    { now }\n  );\n',
    '  const ambiguity = projectGuestAccessAmbiguityIssue(\n    snapshot,\n    {\n      now,\n      e15Enabled: input.e15Enabled === true,\n    }\n  );\n',
    'EXIT_A_E14_MC_PROJECT_ANCHOR',
)

e14_safety = 'src/e14/guest-access-admission-safety-cycle.e14.ts'
replace_once(
    e14_safety,
    '  input: {\n    now?: Date;\n    limit?: number;\n  } = {}\n',
    '  input: {\n    now?: Date;\n    limit?: number;\n    e15Enabled?: boolean;\n  } = {}\n',
    'EXIT_A_E14_SAFETY_INPUT_ANCHOR',
)
replace_once(
    e14_safety,
    '          reservationId,\n          { now }\n        );\n',
    '          reservationId,\n          {\n            now,\n            e15Enabled: input.e15Enabled === true,\n          }\n        );\n',
    'EXIT_A_E14_SAFETY_MC_ANCHOR',
)

print('EXIT_A_PATCH_PART2_OK')
