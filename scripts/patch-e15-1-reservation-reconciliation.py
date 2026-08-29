from pathlib import Path

SERVICE = Path("src/e15/guest-access-ambiguity-reconciliation.e15.ts")
WORKFLOW = Path(".github/workflows/guest-journey-enterprise-e15-certification.yml")

text = SERVICE.read_text(encoding="utf-8")

import_anchor = '''import type {
  GuestAccessAmbiguityE15Config,
} from "./guest-access-ambiguity-reconciliation.config.e15";
'''
import_block = import_anchor + '''import {
  adoptProviderCredentialUnderReservationFenceE15_1,
  rearmAmbiguousGrantUnderReservationFenceE15_1,
  reconcileAccessIntentUnderReservationFenceE15_1,
} from "./guest-access-reservation-reconciliation-fence.e15-1";
'''
if text.count(import_anchor) != 1:
    raise SystemExit("E15_1_IMPORT_ANCHOR_MISMATCH")
text = text.replace(import_anchor, import_block, 1)

adopt_start = '      const adopted = await prisma.$transaction(async (tx) => {\n'
adopt_end = '      if (adopted) metrics.reconciledPresent += 1;\n'
if text.count(adopt_start) != 1 or text.count(adopt_end) != 1:
    raise SystemExit("E15_1_ADOPTION_ANCHOR_MISMATCH")
start = text.index(adopt_start)
end = text.index(adopt_end, start)
new_adoption = '''      let adopted = false;
      try {
        adopted =
          await adoptProviderCredentialUnderReservationFenceE15_1(
            prisma,
            {
              grantId: grant.id,
              reservationId: reservation.id,
              organizationId,
              propertyId: reservation.propertyId,
              startsAt: grant.startsAt,
              endsAt: grant.endsAt,
              updatedAt: grant.updatedAt,
              recoveryAttemptCount: grant.recoveryAttemptCount,
              ttlockLockId,
              now,
              keyboardPwdId: item.keyboardPwdId,
              code,
              maskedCode: masked,
              encryptedCode: encrypted,
              hashedCode: hashed,
              payload,
              guestPhone: reservation.guestPhone ?? null,
            }
          );
      } catch {
        metrics.races += 1;
        continue;
      }
'''
text = text[:start] + new_adoption + text[end:]

rearm_start = '    const rearmed = await prisma.accessGrant.updateMany({\n'
rearm_end = '    else metrics.races += 1;\n'
if text.count(rearm_start) != 1:
    raise SystemExit("E15_1_REARM_ANCHOR_MISMATCH")
start = text.index(rearm_start)
end = text.index(rearm_end, start) + len(rearm_end)
new_rearm = '''    let rearmed = false;
    try {
      rearmed =
        await rearmAmbiguousGrantUnderReservationFenceE15_1(
          prisma,
          {
            grantId: grant.id,
            reservationId: reservation.id,
            organizationId,
            propertyId: reservation.propertyId,
            startsAt: grant.startsAt,
            endsAt: grant.endsAt,
            updatedAt: grant.updatedAt,
            recoveryAttemptCount: grant.recoveryAttemptCount,
            ttlockLockId,
            now,
            payload: withMarker(grant.ttlockPayload, rearmedMarker),
          }
        );
    } catch {
      metrics.races += 1;
      continue;
    }
    if (rearmed) metrics.rearmedGrants += 1;
    else metrics.races += 1;
'''
text = text[:start] + new_rearm + text[end:]

intent_start = '  const intents = await prisma.guestJourneyCoordinationIntent.findMany({\n'
intent_end = '  metrics.durationMs = Date.now() - startedAt;\n'
if text.count(intent_start) != 1:
    raise SystemExit("E15_1_INTENT_START_ANCHOR_MISMATCH")
start = text.index(intent_start)
try:
    end = text.index(intent_end, start)
except ValueError as exc:
    raise SystemExit("E15_1_INTENT_END_ANCHOR_MISMATCH") from exc
new_intents = '''  const intents = await prisma.guestJourneyCoordinationIntent.findMany({
    where: {
      targetEngine: "ACCESS",
      intentType: "REQUEST_ACCESS_PROVISIONING",
      status: GuestJourneyCoordinationIntentStatus.EXHAUSTED,
      lastError: { contains: "AMBIGUOUS" },
      AND: [buildGuestJourneyCoordinationIntentScopeWhere(input.scope)],
    },
    orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
    take: input.config.batchSize,
    select: {
      id: true,
      status: true,
      claimCount: true,
      updatedAt: true,
      lastError: true,
      reservation: {
        select: {
          id: true,
          propertyId: true,
          property: { select: { organizationId: true } },
        },
      },
    },
  });

  const intentRearmAllowed = controlledRearmPrerequisites({
    configured: input.config.controlledRearmEnabled,
    e14Enabled: input.e14Enabled,
    accessOwnerEnabled: input.accessOwnerEnabled,
  });

  for (const intent of intents) {
    let reconciliation;
    try {
      reconciliation =
        await reconcileAccessIntentUnderReservationFenceE15_1(
          prisma,
          {
            intentId: intent.id,
            reservationId: intent.reservation.id,
            organizationId:
              intent.reservation.property.organizationId,
            propertyId: intent.reservation.propertyId,
            claimCount: intent.claimCount,
            updatedAt: intent.updatedAt,
            lastError: intent.lastError,
            controlledRearmEnabled: intentRearmAllowed,
            scope: input.scope,
            now,
          }
        );
    } catch {
      metrics.races += 1;
      continue;
    }

    if (reconciliation.action === "SUCCEEDED") {
      metrics.reconciledIntents += 1;
    } else if (reconciliation.action === "REARMED") {
      metrics.rearmedIntents += 1;
    }
  }

'''
text = text[:start] + new_intents + text[end:]

if text.count("adoptProviderCredentialUnderReservationFenceE15_1") != 2:
    raise SystemExit("E15_1_ADOPTION_INTEGRATION_COUNT_INVALID")
if text.count("rearmAmbiguousGrantUnderReservationFenceE15_1") != 2:
    raise SystemExit("E15_1_REARM_INTEGRATION_COUNT_INVALID")
if text.count("reconcileAccessIntentUnderReservationFenceE15_1") != 2:
    raise SystemExit("E15_1_INTENT_INTEGRATION_COUNT_INVALID")
if "const adopted = await prisma.$transaction" in text:
    raise SystemExit("E15_1_LEGACY_ADOPTION_REMAINS")
if "const rearmed = await prisma.accessGrant.updateMany" in text:
    raise SystemExit("E15_1_LEGACY_REARM_REMAINS")
if "intent.reservation.accessGrants" in text:
    raise SystemExit("E15_1_LEGACY_INTENT_GRANT_SEARCH_REMAINS")
SERVICE.write_text(text, encoding="utf-8")

workflow = WORKFLOW.read_text(encoding="utf-8")
old_test = "node --import tsx --test src/e15/guest-access-ambiguity-reconciliation.e15.test.ts"
new_test = "node --import tsx --test src/e15/guest-access-ambiguity-reconciliation.e15.test.ts src/e15/guest-access-reservation-reconciliation-fence.e15-1.test.ts"
if workflow.count(old_test) != 1:
    raise SystemExit("E15_1_WORKFLOW_TEST_ANCHOR_MISMATCH")
workflow = workflow.replace(old_test, new_test, 1)
WORKFLOW.write_text(workflow, encoding="utf-8")
