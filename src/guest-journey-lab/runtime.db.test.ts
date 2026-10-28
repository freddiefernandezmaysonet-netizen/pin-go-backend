import assert from "node:assert/strict";
import test from "node:test";
import { assertLabEnvironment, installLabNetworkFence } from "./isolation";

assertLabEnvironment(process.env);
installLabNetworkFence();
const lab = await import("./runtime");
const { reconcileGuestJourneyCommunicationEvidence: reconcile } = await import("../services/guest-journey-communications-recovery.service");
test.after(() => lab.prisma.$disconnect());

test("real E4/E7 persists claims, simulated receipts and uncertain results without replay", async () => {
  await lab.prepareLabTables();
  await lab.seedLabFixtures();
  await lab.runCommunicationsProbe();
  const first = await lab.readLabEvidence();
  const message = (scenario: string) => first.messages.find(row => row.id === lab.fixtureMessageId(scenario))!;
  assert.equal(message("accepted").status, "SENT");
  assert.equal(message("accepted").providerDeliveryStatus, "DELIVERED");
  assert.equal(message("empty_ack").status, "E7_SENDING");
  assert.equal(message("empty_ack").providerMessageId, null);
  assert.equal(message("timeout").status, "E7_SENDING");
  assert.equal(message("ota_channel").status, "OBSOLETE");
  assert.equal(first.durableAttempts, 6);
  assert.deepEqual(first.calls, [
    { scenario: "accepted", calls: 1 }, { scenario: "empty_ack", calls: 1 },
    { scenario: "late_ack", calls: 1 }, { scenario: "late_failure", calls: 1 }, { scenario: "timeout", calls: 1 },
  ]);
  const late = first.intents.find(intent => intent.reservationId.endsWith("_late_ack"))!;
  const input = { intentId: late.id, ...lab.scope };
  await assert.rejects(reconcile(lab.prisma, { ...input, organizationId: "wrong-org" }), /SCOPE_MISMATCH/);
  // A redeploy of this exact commit must preserve already-certified evidence.
  if (late.status !== "SUCCEEDED") {
    for (let i = 0; i < 60; i++) {
      const messages = await lab.prisma.messageLog.findMany({ where: {
        id: { in: [lab.fixtureMessageId("late_ack"), lab.fixtureMessageId("late_failure")] },
        providerMessageId: { not: null },
      } });
      if (messages.length === 2) break;
      await new Promise(done => setTimeout(done, 50));
    }
    const acknowledgement = await lab.prisma.messageLog.findUniqueOrThrow({ where: { id: lab.fixtureMessageId("late_ack") } });
    assert.ok(acknowledgement.providerMessageId, "late acknowledgement must survive the timeout");
    assert.equal(acknowledgement.status, "E7_SENDING");
    assert.equal(acknowledgement.deliveredAt, null);
    assert.equal((await reconcile(lab.prisma, input)).action, "WAITING", "acceptance cannot close delivery");
    await lab.emitLabRecoveryReceipts();
    // Persisted receipts survive a lost connection before reconciliation.
    await lab.prisma.$disconnect();
    await lab.prisma.$connect();
    await assert.rejects(async () => {
      const result = await reconcile(lab.prisma, input, { persistAudit: async () => {
        throw new Error("SIMULATED_AUDIT_WRITE_FAILURE");
      } });
      const evidence = await lab.prisma.messageLog.findUnique({ where: { id: acknowledgement.id },
        select: { provider: true, status: true, providerMessageId: true, providerDeliveryStatus: true,
          providerStatusUpdatedAt: true, deliveredAt: true } });
      throw new Error(`RECOVERY_DID_NOT_REACH_AUDIT:${JSON.stringify({ result, evidence })}`);
    }, /SIMULATED_AUDIT_WRITE_FAILURE/);
    assert.equal((await lab.prisma.guestJourneyCoordinationIntent.findUniqueOrThrow({ where: { id: late.id } })).status, "WAITING_FOR_EVIDENCE");
    assert.equal((await lab.prisma.messageLog.findUniqueOrThrow({ where: { id: acknowledgement.id } })).status, "E7_SENDING");
    const race = await Promise.allSettled([reconcile(lab.prisma, input), reconcile(lab.prisma, input)]);
    assert.equal(race.filter(result => result.status === "fulfilled" && result.value.action === "RECOVERED").length, 1);
    for (const result of race) if (result.status === "rejected") assert.equal(result.reason.code, "P2034");
  }
  assert.equal((await reconcile(lab.prisma, input)).action, "NOT_REQUIRED");
  await lab.runRecoveryProbe();
  const recovered = await lab.readLabEvidence();
  assert.equal(recovered.intents.filter(intent => intent.status === "WAITING_FOR_EVIDENCE").length, 3);
  assert.equal(recovered.recoveryAudit.length, 1);
  assert.equal(recovered.issues.filter(issue => issue.workflowState === "RESOLVED").length, 1);
  assert.equal(recovered.issues.filter(issue => issue.workflowState === "ACTION_REQUIRED").length, 3);
  assert.ok(recovered.issues.every(issue => issue.visibility === "HOST"));
  assert.equal(recovered.messages.find(row => row.id === lab.fixtureMessageId("late_ack"))!.providerDeliveryStatus, "DELIVERED");
  assert.equal(recovered.messages.find(row => row.id === lab.fixtureMessageId("late_failure"))!.status, "E7_SENDING");
  assert.equal(recovered.messages.find(row => row.id === lab.fixtureMessageId("late_failure"))!.providerDeliveryStatus, "UNDELIVERED");
  assert.equal((await lab.prisma.guestJourneyCoordinationIntentAttempt.findUniqueOrThrow({ where: {
    intentId_attemptNumber: { intentId: late.id, attemptNumber: 1 },
  } })).outcome, "WAITING_FOR_EVIDENCE", "historical attempts must remain immutable");
  // Re-seeding and repeating ticks must not reset durable attempts or messages.
  await lab.seedLabFixtures();
  await lab.runCommunicationsProbe();
  await lab.runRecoveryProbe();
  await lab.prisma.$disconnect();
  await lab.prisma.$connect();
  await lab.runCommunicationsProbe();
  const replay = await lab.readLabEvidence();
  assert.deepEqual(replay.calls, first.calls);
  assert.equal(replay.durableAttempts, first.durableAttempts);
  assert.equal(replay.recoveryAudit.length, 1);
  assert.equal(await lab.prisma.guestJourneyCoordinationIntent.count({ where: {
    targetEngine: { not: "COMMUNICATIONS" }, claimCount: { gt: 0 },
  } }), 0, "no other Owner may claim an intent");
  assert.equal(replay.productionReady, false);
});

test("reservation snapshots produce durable pre-check-in shadow obligations without executable effects", async () => {
  const shadow = await import("./precheckin-shadow");
  await lab.prepareLabTables();
  await shadow.seedPrecheckinShadow(lab.prisma, lab.fixtureRevision);
  const scope = shadow.shadowScope(lab.fixtureRevision);
  assert.equal(await lab.prisma.reservation.count({ where: { propertyId: scope.propertyId } }), 14);
  const messageCount = () => lab.prisma.messageLog.count({ where: scope });
  assert.equal(await messageCount(), 1, "only the deliberately uncertain prior SMS is seeded");
  const race = await Promise.allSettled([
    shadow.runPrecheckinShadow(lab.prisma, lab.fixtureRevision),
    shadow.runPrecheckinShadow(lab.prisma, lab.fixtureRevision),
  ]);
  assert.ok(race.some(result => result.status === "fulfilled"));
  for (const result of race) if (result.status === "rejected") assert.equal(result.reason.code, "P2034");
  await shadow.runPrecheckinShadow(lab.prisma, lab.fixtureRevision);
  const first = await shadow.readPrecheckinShadow(lab.prisma, lab.fixtureRevision);
  assert.equal(first.observations.length, 25);
  assert.equal(new Set(first.observations.map(row => row.evidence.effectKey)).size, 25);
  const rows = (scenario: string) => first.observations.filter(row => row.scenario === scenario).map(row => row.evidence);
  const required = (scenario: string) => rows(scenario).filter(row => row.state === "REQUIRED").map(row => row.channel).sort();
  assert.deepEqual(required("direct_due"), ["email", "sms"]);
  assert.deepEqual(required("no_consent"), ["email"]);
  assert.deepEqual(required("after_arrival"), ["sms"]);
  assert.deepEqual(required("late_booking"), ["email", "sms"]);
  assert.deepEqual(required("legacy_email"), ["sms"]);
  assert.deepEqual(required("unknown_sms"), ["email"]);
  for (const scenario of ["before_window", "unpaid", "cancelled", "checkout", "missing_contacts"])
    assert.deepEqual(required(scenario), []);
  for (const scenario of ["airbnb", "booking_com", "ota_no_contacts"]) {
    assert.deepEqual(required(scenario), ["channex"]);
    assert.equal(rows(scenario)[0].owner, "CHANNEX_OPERATIONAL");
  }
  assert.ok(rows("ota_no_contacts")[0].gaps.includes("LEGACY_WORKER_HAS_NO_ELIGIBLE_TRIGGER"));
  assert.equal(first.executableIntents, 0);
  assert.equal(first.dispatchableMessages, 0);
  assert.equal(first.providerCalls, 0);
  assert.equal(first.deliveryCertified, false);
  assert.ok(first.observations.every(row => !row.evidence.dispatchAllowed && row.evidence.receipt === "NOT_CERTIFIED"));
  await lab.prisma.$disconnect();
  await lab.prisma.$connect();
  await shadow.seedPrecheckinShadow(lab.prisma, lab.fixtureRevision);
  assert.equal((await shadow.runPrecheckinShadow(lab.prisma, lab.fixtureRevision)).recorded, 0);
  assert.deepEqual(await shadow.readPrecheckinShadow(lab.prisma, lab.fixtureRevision), first);
  assert.equal(await messageCount(), 1);
  assert.equal((await shadow.readPrecheckinShadow(lab.prisma, "unrelated_revision")).observations.length, 0);
});
