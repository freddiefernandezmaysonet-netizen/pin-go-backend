from pathlib import Path


def replace_exact(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text(encoding="utf-8")
    if new in text:
        return
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected exactly one source block, found {count}")
    p.write_text(text.replace(old, new, 1), encoding="utf-8")


def append_once(path: str, marker: str, block: str) -> None:
    p = Path(path)
    text = p.read_text(encoding="utf-8")
    if marker in text:
        return
    p.write_text(text.rstrip() + "\n\n" + block.strip() + "\n", encoding="utf-8")


# E8: durable Access -> Communications handoff before Access success completion.
path = "src/services/guest-journey-access-owner-cycle.service.ts"
replace_exact(
    path,
    'import { executeGuestJourneyAccessOwnerAdapter } from "./guest-journey-access-owner-adapter.service";\n',
    'import { executeGuestJourneyAccessOwnerAdapter } from "./guest-journey-access-owner-adapter.service";\n'
    'import { materializeGuestAccessCommunicationOutbox } from "./guest-journey-access-communications-outbox.service";\n',
)
replace_exact(
    path,
    '  complete: typeof completeGuestJourneyAccessIntent;\n  syncMissionControl: typeof syncGuestJourneyAccessOwnerMissionControl;\n',
    '  complete: typeof completeGuestJourneyAccessIntent;\n'
    '  materializeAccessCommunications: typeof materializeGuestAccessCommunicationOutbox;\n'
    '  syncMissionControl: typeof syncGuestJourneyAccessOwnerMissionControl;\n',
)
replace_exact(
    path,
    '  complete: completeGuestJourneyAccessIntent,\n  syncMissionControl: syncGuestJourneyAccessOwnerMissionControl,\n',
    '  complete: completeGuestJourneyAccessIntent,\n'
    '  materializeAccessCommunications: materializeGuestAccessCommunicationOutbox,\n'
    '  syncMissionControl: syncGuestJourneyAccessOwnerMissionControl,\n',
)
replace_exact(
    path,
    '''      const completed = await dependencies.complete(prisma, {\n        claim: claimed.claim,\n        completion,\n        maxClaims: config.maxClaims,\n        retryBaseMs: config.retryBaseMs,\n        now: dependencies.clock(),\n      });\n''',
    '''      if (\n        claimed.claim.intentType === "REQUEST_ACCESS_PROVISIONING" &&\n        completion.kind === "SUCCEEDED" &&\n        ["PROVISIONED", "ALREADY_SATISFIED"].includes(completion.action)\n      ) {\n        try {\n          await dependencies.materializeAccessCommunications(prisma, {\n            reservationId: claimed.claim.reservationId,\n            organizationId: claimed.claim.organizationId,\n            propertyId: claimed.claim.propertyId,\n            accessGrantIds: completion.accessGrantIds,\n          });\n        } catch (error) {\n          const normalized = normalizeAccessOwnerError(error);\n          completion = {\n            kind: "RETRYABLE" as const,\n            outcomeEvidenceFingerprint: completion.outcomeEvidenceFingerprint,\n            errorCode: "ACCESS_COMMUNICATIONS_OUTBOX_MATERIALIZATION_FAILED",\n            errorDetail: normalized.detail,\n            accessGrantIds: completion.accessGrantIds,\n          };\n        }\n      }\n\n      const completed = await dependencies.complete(prisma, {\n        claim: claimed.claim,\n        completion,\n        maxClaims: config.maxClaims,\n        retryBaseMs: config.retryBaseMs,\n        now: dependencies.clock(),\n      });\n''',
)

# E4: APMS_PENDING is a first-send obligation; FAILED remains retry-only.
path = "src/services/guest-journey-evaluator.ts"
replace_exact(
    path,
    '''  for (\n    const communicationSignal of\n    evidence.communications.signals\n  ) {\n    if (\n      communicationSignal.status\n        .trim()\n        .toUpperCase() !==\n      "FAILED"\n    ) {\n      continue;\n    }\n\n    addIntent({\n      intentType:\n        "REQUEST_COMMUNICATION_RETRY",\n      targetEngine:\n        "COMMUNICATIONS",\n      reasonCode:\n        "COMMUNICATION_DELIVERY_FAILED",\n      expectedOutcomeCode:\n        "COMMUNICATION_DELIVERY_FINAL",\n      payload: {\n        ...(communicationSignal.messageLogId\n          ? {\n              messageLogId:\n                communicationSignal.messageLogId,\n            }\n          : {}),\n        communicationType:\n          communicationSignal\n            .communicationType,\n        channel:\n          communicationSignal.channel,\n      },\n    });\n  }\n''',
    '''  for (\n    const communicationSignal of\n    evidence.communications.signals\n  ) {\n    const communicationStatus =\n      communicationSignal.status\n        .trim()\n        .toUpperCase();\n\n    if (communicationStatus === "APMS_PENDING") {\n      addIntent({\n        intentType:\n          "REQUEST_COMMUNICATION",\n        targetEngine:\n          "COMMUNICATIONS",\n        reasonCode:\n          "COMMUNICATION_DELIVERY_PENDING",\n        expectedOutcomeCode:\n          "COMMUNICATION_DELIVERY_FINAL",\n        payload: {\n          ...(communicationSignal.messageLogId\n            ? {\n                messageLogId:\n                  communicationSignal.messageLogId,\n              }\n            : {}),\n          communicationType:\n            communicationSignal\n              .communicationType,\n          channel:\n            communicationSignal.channel,\n        },\n      });\n      continue;\n    }\n\n    if (communicationStatus !== "FAILED") {\n      continue;\n    }\n\n    addIntent({\n      intentType:\n        "REQUEST_COMMUNICATION_RETRY",\n      targetEngine:\n        "COMMUNICATIONS",\n      reasonCode:\n        "COMMUNICATION_DELIVERY_FAILED",\n      expectedOutcomeCode:\n        "COMMUNICATION_DELIVERY_FINAL",\n      payload: {\n        ...(communicationSignal.messageLogId\n          ? {\n              messageLogId:\n                communicationSignal.messageLogId,\n            }\n          : {}),\n        communicationType:\n          communicationSignal\n            .communicationType,\n        channel:\n          communicationSignal.channel,\n      },\n    });\n  }\n''',
)

# E7: first-send only owns APMS_PENDING; retry only owns FAILED.
path = "src/services/guest-journey-communications-delivery-adapter.service.ts"
replace_exact(
    path,
    '''  if (clean(message.status).toUpperCase() !== "FAILED") {\n    return {\n      providerCalls: 0,\n      completion: {\n        kind: "WAITING_FOR_EVIDENCE",\n        outcomeEvidenceFingerprint: hashEvidence({ messageLogId, status: message.status }),\n        errorCode: "COMMUNICATION_NOT_RETRYABLE",\n        errorDetail: `The correlated message has non-retryable status ${message.status ?? "UNKNOWN"}.`,\n        messageLogId,\n        communicationType: requestedType,\n        channel: requestedChannel,\n      },\n    };\n  }\n''',
    '''  const normalizedMessageStatus = clean(message.status).toUpperCase();\n  const expectedOwnedStatus =\n    claim.intentType === "REQUEST_COMMUNICATION"\n      ? "APMS_PENDING"\n      : "FAILED";\n\n  if (normalizedMessageStatus !== expectedOwnedStatus) {\n    return {\n      providerCalls: 0,\n      completion: {\n        kind: "WAITING_FOR_EVIDENCE",\n        outcomeEvidenceFingerprint: hashEvidence({ messageLogId, status: message.status }),\n        errorCode:\n          claim.intentType === "REQUEST_COMMUNICATION"\n            ? "COMMUNICATION_NOT_PENDING"\n            : "COMMUNICATION_NOT_RETRYABLE",\n        errorDetail:\n          `The correlated message has status ${message.status ?? "UNKNOWN"}; ${claim.intentType} requires ${expectedOwnedStatus}.`,\n        messageLogId,\n        communicationType: requestedType,\n        channel: requestedChannel,\n      },\n    };\n  }\n''',
)

# Existing E8 success fixture must explicitly stub the newly certified handoff.
path = "src/services/guest-journey-access-owner-cycle.service.test.ts"
replace_exact(
    path,
    '''        complete: async () => {\n          calls.push("complete");\n          return {\n''',
    '''        materializeAccessCommunications: async (_prisma, input) => {\n          calls.push("outbox");\n          assert.equal(input.reservationId, "reservation-1");\n          assert.deepEqual(input.accessGrantIds, ["grant-1"]);\n          return {\n            canonicalAccessGrantId: "grant-1",\n            proposed: 2,\n            created: 2,\n            deduplicated: 0,\n          };\n        },\n        complete: async () => {\n          calls.push("complete");\n          return {\n''',
)
replace_exact(
    path,
    '  assert.deepEqual(calls, ["claim", "execute", "complete", "mission-control"]);\n',
    '  assert.deepEqual(calls, ["claim", "execute", "outbox", "complete", "mission-control"]);\n',
)

# E4 focused first-send regression.
append_once(
    "src/services/guest-journey-evaluator.test.ts",
    'proposes first-send Communications work for durable APMS_PENDING access delivery',
    r'''test(
  "proposes first-send Communications work for durable APMS_PENDING access delivery",
  () => {
    const evaluation = evaluateCanonicalGuestJourney(
      createEvidence({
        communications: {
          signals: [
            {
              messageLogId: "gjcomm_pending_1",
              communicationType: "GUEST_ACCESS_PASSCODE",
              channel: "email",
              status: "APMS_PENDING",
              retryCount: 0,
              lastError: null,
            },
          ],
        },
      })
    );

    const intent = evaluation.requiredCoordinationIntents.find(
      (candidate) => candidate.intentType === "REQUEST_COMMUNICATION"
    );
    assert.ok(intent);
    assert.equal(intent.targetEngine, "COMMUNICATIONS");
    assert.equal(intent.reasonCode, "COMMUNICATION_DELIVERY_PENDING");
    assert.equal(intent.payload?.messageLogId, "gjcomm_pending_1");
    assert.equal(intent.payload?.communicationType, "GUEST_ACCESS_PASSCODE");
    assert.equal(intent.payload?.channel, "email");
  }
);''',
)

# E7 helper accepts explicit first-send intents while preserving every existing retry fixture.
path = "src/services/guest-journey-communications-delivery-adapter.service.test.ts"
replace_exact(
    path,
    '''function claim(payload: Record<string, unknown>): ClaimedCommunicationIntent {\n  return {\n''',
    '''function claim(\n  payload: Record<string, unknown>,\n  intentType: ClaimedCommunicationIntent["intentType"] = "REQUEST_COMMUNICATION_RETRY"\n): ClaimedCommunicationIntent {\n  return {\n''',
)
replace_exact(
    path,
    '''    intentType: "REQUEST_COMMUNICATION_RETRY",\n''',
    '''    intentType,\n''',
)
append_once(
    path,
    'first-send claims own APMS_PENDING delivery exactly once',
    r'''test("first-send claims own APMS_PENDING delivery exactly once", async () => {
  const envelope = JSON.stringify({
    kind: "PIN_GO_EMAIL_DELIVERY",
    type: "GUEST_ACCESS_PASSCODE",
    retryPayload: {
      reservationNumber: "PG-2026-000044",
      accessGrantId: "grant-1",
      validFrom: "2026-08-24T20:00:00.000Z",
      validUntil: "2026-08-27T15:00:00.000Z",
      preferredLanguage: "en",
    },
  });
  const { prisma, message } = fakePrisma({
    message: {
      status: "APMS_PENDING",
      communicationType: "GUEST_ACCESS_PASSCODE",
      channel: "email",
      to: "guest@example.com",
      body: envelope,
    },
  });
  let calls = 0;
  const result = await executeGuestJourneyCommunicationDeliveryAdapter(
    prisma,
    claim(
      {
        messageLogId: "message-1",
        communicationType: "GUEST_ACCESS_PASSCODE",
        channel: "email",
      },
      "REQUEST_COMMUNICATION"
    ),
    { now, providerTimeoutMs: 100 },
    {
      sendSms: async () => { throw new Error("sms must not execute"); },
      sendEmail: async (input) => {
        calls += 1;
        assert.equal(input.type, "GUEST_ACCESS_PASSCODE");
        assert.equal(input.to, "guest@example.com");
        assert.equal(input.retryPayload.accessGrantId, "grant-1");
        return { id: "email-new" };
      },
    }
  );
  assert.equal(calls, 1);
  assert.equal(message.status, "SENT");
  assert.equal(result.providerCalls, 1);
  assert.equal(result.completion.kind, "SUCCEEDED");
});''',
)

print("APMS access communications parity wiring applied or already present")
