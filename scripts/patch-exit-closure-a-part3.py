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
# Access Owner MC must not block E15 itself with a CRITICAL issue.
# ---------------------------------------------------------------------------
owner_mc = 'src/services/guest-journey-access-owner-mission-control.service.ts'
insert_after(
    owner_mc,
    'import { upsertOperationalIssue } from "../apms/operational-intelligence.service";\n',
    'import {\n  guestAccessE15NextAutomaticStep,\n  isGuestAccessE15AutoResolvableOwnerExhaustion,\n} from "./guest-access-exit-closure-a.policy";\n',
    'EXIT_A_OWNER_MC_IMPORT_ANCHOR',
)
replace_once(
    owner_mc,
    '  expectedScope: { organizationId: string; propertyId: string },\n',
    '  expectedScope: {\n    organizationId: string;\n    propertyId: string;\n    e15Enabled?: boolean;\n  },\n',
    'EXIT_A_OWNER_MC_SCOPE_ANCHOR',
)
replace_once(
    owner_mc,
    '  if (\n    existing?.workflowState === "ACTION_REQUIRED" &&\n    existing.lastSignalAt.getTime() >= intent.updatedAt.getTime()\n  ) {\n',
    '  const e15AutoResolving =\n    isGuestAccessE15AutoResolvableOwnerExhaustion({\n      e15Enabled: expectedScope.e15Enabled === true,\n      intentType: intent.intentType,\n      lastError: intent.lastError,\n    });\n  const desiredWorkflowState = e15AutoResolving\n    ? "AUTO_RESOLVING"\n    : "ACTION_REQUIRED";\n\n  if (\n    existing?.workflowState === desiredWorkflowState &&\n    existing.lastSignalAt.getTime() >= intent.updatedAt.getTime()\n  ) {\n',
    'EXIT_A_OWNER_MC_DEDUPE_ANCHOR',
)
replacements = {
    '    title: "Guest access owner exhausted automatic recovery",\n': '    title: e15AutoResolving\n      ? "Guest access owner is reconciling an uncertain outcome"\n      : "Guest access owner exhausted automatic recovery",\n',
    '    issue: "The fenced ACCESS owner stopped before replaying an uncertain hardware operation.",\n': '    issue: e15AutoResolving\n      ? "The ACCESS owner fenced an uncertain provider outcome and delegated reconciliation to E15."\n      : "The fenced ACCESS owner stopped before replaying an uncertain hardware operation.",\n',
    '    operationalImpact: "Guest access provisioning or closure is not completely confirmed.",\n': '    operationalImpact: e15AutoResolving\n      ? "Automatic replay remains blocked while Pin&Go verifies provider state."\n      : "Guest access provisioning or closure is not completely confirmed.",\n',
    '    recommendedAction: "Reconcile the correlated grant and TTLock evidence before rearming this intent.",\n': '    recommendedAction: e15AutoResolving\n      ? null\n      : "Reconcile the correlated grant and TTLock evidence before rearming this intent.",\n',
    '    nextAutomaticStep: null,\n    engine: "GUEST_JOURNEY",\n    severity: "CRITICAL",\n    workflowState: "ACTION_REQUIRED",\n    visibility: "DEVELOPER",\n    responsibleActor: "SYSTEM",\n    actionRequired: true,\n    canAutoResolve: false,\n    autoResolveStatus: "NOT_SUPPORTED",\n': '    nextAutomaticStep: e15AutoResolving\n      ? guestAccessE15NextAutomaticStep(null)\n      : null,\n    engine: "GUEST_JOURNEY",\n    severity: e15AutoResolving ? "WARNING" : "CRITICAL",\n    workflowState: desiredWorkflowState,\n    visibility: e15AutoResolving ? "SYSTEM" : "DEVELOPER",\n    responsibleActor: e15AutoResolving ? "PIN_GO" : "SYSTEM",\n    actionRequired: !e15AutoResolving,\n    canAutoResolve: e15AutoResolving,\n    autoResolveStatus: e15AutoResolving ? "AVAILABLE" : "NOT_SUPPORTED",\n',
    '    transitionCode: "GUEST_JOURNEY_ACCESS_OWNER_RETRY_BUDGET_EXHAUSTED",\n    transitionSummary: "The ACCESS owner fenced uncertain execution and escalated.",\n': '    transitionCode: e15AutoResolving\n      ? "GUEST_JOURNEY_ACCESS_OWNER_DELEGATED_TO_E15"\n      : "GUEST_JOURNEY_ACCESS_OWNER_RETRY_BUDGET_EXHAUSTED",\n    transitionSummary: e15AutoResolving\n      ? "The ACCESS owner delegated fenced ambiguity to E15 reconciliation."\n      : "The ACCESS owner fenced uncertain execution and escalated.",\n',
}
for old, new in replacements.items():
    replace_once(owner_mc, old, new, 'EXIT_A_OWNER_MC_FIELD_ANCHOR')

owner_cycle = 'src/services/guest-journey-access-owner-cycle.service.ts'
replace_once(
    owner_cycle,
    '  options: {\n    now?: Date;\n    logger?: (entry: {\n',
    '  options: {\n    now?: Date;\n    e15Enabled?: boolean;\n    logger?: (entry: {\n',
    'EXIT_A_OWNER_CYCLE_OPTIONS_ANCHOR',
)
p = Path(owner_cycle)
text = p.read_text(encoding='utf-8')
old_scope = '''            {\n              organizationId: candidate.reservation.property.organizationId,\n              propertyId: candidate.reservation.propertyId,\n            }\n'''
if text.count(old_scope) != 1:
    raise SystemExit(f'EXIT_A_OWNER_CYCLE_CANDIDATE_SCOPE_ANCHOR:{text.count(old_scope)}')
text = text.replace(old_scope, '''            {\n              organizationId: candidate.reservation.property.organizationId,\n              propertyId: candidate.reservation.propertyId,\n              e15Enabled: options.e15Enabled === true,\n            }\n''', 1)
old_scope2 = '''        {\n          organizationId: claimed.claim.organizationId,\n          propertyId: claimed.claim.propertyId,\n        }\n'''
if text.count(old_scope2) != 1:
    raise SystemExit(f'EXIT_A_OWNER_CYCLE_CLAIM_SCOPE_ANCHOR:{text.count(old_scope2)}')
text = text.replace(old_scope2, '''        {\n          organizationId: claimed.claim.organizationId,\n          propertyId: claimed.claim.propertyId,\n          e15Enabled: options.e15Enabled === true,\n        }\n''', 1)
p.write_text(text, encoding='utf-8')

worker = 'src/workers/reservation.worker.ts'
replace_once(
    worker,
    '          await runGuestAccessAdmissionSafetyCycle(\n            prisma,\n            { now }\n          );\n',
    '          await runGuestAccessAdmissionSafetyCycle(\n            prisma,\n            {\n              now,\n              e15Enabled:\n                GUEST_ACCESS_AMBIGUITY_E15_CONFIG.enabled,\n            }\n          );\n',
    'EXIT_A_WORKER_E14_SAFETY_ANCHOR',
)
replace_once(
    worker,
    '              GUEST_JOURNEY_ACCESS_OWNER_CONFIG,\n              { now }\n            );\n',
    '              GUEST_JOURNEY_ACCESS_OWNER_CONFIG,\n              {\n                now,\n                e15Enabled:\n                  GUEST_ACCESS_AMBIGUITY_E15_CONFIG.enabled,\n              }\n            );\n',
    'EXIT_A_WORKER_OWNER_CYCLE_ANCHOR',
)

print('EXIT_A_PATCH_PART3_OK')
