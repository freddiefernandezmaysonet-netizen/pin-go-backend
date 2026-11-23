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
  for (const result of race) if (result.status === "rejected") {
    // Prisma maps ORM conflicts to P2034 but raw SQL serialization failures to
    // P2010 + PostgreSQL 40001. No other raw-query failure is an allowed retry.
    if (result.reason.code !== "P2034") {
      assert.equal(result.reason.code, "P2010");
      assert.equal(result.reason.meta?.code, "40001");
    }
  }
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

test("first-send commits outbox plus intent atomically and certifies simulated delivery without consuming another channel", async () => {
  const producer = await import("./precheckin-first-send");
  const probe = await import("./precheckin-first-send.runtime");
  await lab.seedLabFixtures();
  const revision = lab.fixtureRevision;
  const scope = producer.firstSendScope(revision);
  const id = (scenario: string) => producer.firstSendReservationId(revision, scenario);
  const property = await lab.prisma.property.findUniqueOrThrow({ where: { id: scope.propertyId } });
  await assert.rejects(producer.materializeFirstPrecheckin(lab.prisma, revision, "other-reservation", property.createdAt), /SCOPE_MISMATCH/);
  const initial = await probe.readFirstSendEvidence(lab.prisma, revision);
  if (initial.intents.length === 0) {
    assert.equal(initial.messages.length, 1, "only the deliberately uncertain legacy SMS is seeded");
    await assert.rejects(producer.materializeFirstPrecheckin(lab.prisma, revision, id("before_arrival"), property.createdAt,
      { persistAudit: async () => { throw Error("FIRST_SEND_AUDIT_FAILURE"); } }), /FIRST_SEND_AUDIT_FAILURE/);
    assert.equal(await lab.prisma.messageLog.count({ where: { ...scope, reservationId: id("before_arrival") } }), 0);
    assert.equal(await lab.prisma.guestJourneyCoordinationIntent.count({ where: { reservationId: id("before_arrival") } }), 0);
    const race = await Promise.all([
      producer.materializeFirstPrecheckin(lab.prisma, revision, id("before_arrival"), property.createdAt),
      producer.materializeFirstPrecheckin(lab.prisma, revision, id("before_arrival"), property.createdAt),
    ]);
    assert.equal(race.flat().filter(row => row.action === "CREATED").length, 2);
    await probe.materializeFirstSendFixtures(lab.prisma, revision);
    const dispatch = await probe.dispatchFirstSend(lab.prisma, revision);
    assert.equal(dispatch.errors, 0);
    const pending = await probe.readFirstSendEvidence(lab.prisma, revision);
    assert.equal(pending.intents.length, 10);
    assert.ok(pending.intents.every(row => row.status === "WAITING_FOR_EVIDENCE"));
    assert.equal(pending.calls.length, 9);
    assert.equal(pending.messages.filter(row => row.providerDeliveryStatus === "DELIVERED").length, 0);
    const emailIntent = pending.intents.find(row => row.reservationId === id("late_consent"))!;
    await probe.advanceFirstSendConsent(lab.prisma, revision);
    await producer.materializeFirstPrecheckin(lab.prisma, revision, id("late_consent"), property.createdAt);
    const withSms = await probe.readFirstSendEvidence(lab.prisma, revision);
    assert.deepEqual(withSms.intents.find(row => row.id === emailIntent.id), emailIntent,
      "creating the late SMS must not supersede or rearm the pending email");
    assert.equal(withSms.intents.length, 11);
    assert.equal((await probe.dispatchFirstSend(lab.prisma, revision)).errors, 0);
    await probe.receiveFirstSendReceipts(lab.prisma, revision);
  }
  await probe.runFirstSendProbe(lab.prisma, revision);
  const complete = await probe.readFirstSendEvidence(lab.prisma, revision);
  assert.equal(complete.receiptInbox.retained, 2);
  assert.equal(complete.receiptInbox.processed, 2);
  assert.equal(complete.receiptInbox.pending, 0);
  assert.equal(complete.messages.length, 12);
  assert.equal(complete.intents.length, 11);
  assert.equal(complete.attempts.length, 11);
  assert.equal(complete.calls.length, 10);
  assert.ok(complete.calls.every(row => row.calls === 1));
  assert.equal(complete.intents.filter(row => row.status === "SUCCEEDED").length, 10);
  assert.equal(complete.intents.filter(row => row.status === "WAITING_FOR_EVIDENCE").length, 1);
  assert.ok(complete.intents.every(row => row.claimCount === 1 && row.targetEngine === "COMMUNICATIONS"));
  assert.equal(complete.messages.filter(row => row.providerDeliveryStatus === "DELIVERED").length, 10);
  assert.equal(complete.audit.filter(row => row.reason === "PRECHECKIN_FIRST_SEND_MATERIALIZED").length, 11);
  assert.equal(complete.audit.filter(row => row.reason === "COMMUNICATION_DELIVERY_RECEIPT_CONFIRMED").length, 10);
  assert.equal(complete.issues.filter(row => row.workflowState === "ACTION_REQUIRED" && row.visibility === "HOST").length, 1);
  assert.equal(complete.messages.filter(row => [id("ota"), id("cancelled")].includes(row.reservationId!)).length, 0);
  const afterArrival = await lab.prisma.messageLog.findFirstOrThrow({ where: { ...scope, reservationId: id("after_arrival") } });
  assert.match(afterArrival.body, /Informacion de llegada/);
  assert.doesNotMatch(afterArrival.body, /Check-in hoy/);
  await lab.prisma.$disconnect();
  await lab.prisma.$connect();
  await probe.seedFirstSend(lab.prisma, revision);
  await probe.runFirstSendProbe(lab.prisma, revision);
  assert.deepEqual(await probe.readFirstSendEvidence(lab.prisma, revision), complete);
});


test("PostgreSQL receipts survive a new process, deduplicate and reconcile without another send", async () => {
  const { randomUUID } = await import("node:crypto");
  const { execFileSync } = await import("node:child_process");
  const inbox = await import("./receipt-inbox");
  const { recordMessageDeliveryOutcome: record } = await import("../services/guest-journey-communications-delivery-outcome.service");
  await lab.prepareLabTables();
  await lab.seedLabFixtures();
  const suffix = randomUUID().replaceAll("-", "");
  const scope = { organizationId: "gj_lab_organization", propertyId: `gj_lab_receipt_test_${suffix}` };
  await lab.prisma.property.create({ data: { id: scope.propertyId, organizationId: scope.organizationId,
    name: "Synthetic receipt persistence test", isTestProperty: true } });
  const messageId = `receipt_test_${suffix}`;
  const providerId = `LAB_RECEIPT_${suffix}`;
  const eventAt = new Date();
  const receipt = { provider: "twilio" as const, providerMessageId: providerId,
    status: "DELIVERED" as const, eventAt, deliveredAt: eventAt };
  try {
    await lab.prisma.messageLog.create({ data: { id: messageId, ...scope,
      channel: "sms", provider: "twilio", to: "+15005550006", body: "Synthetic receipt test",
      status: "E7_SENDING", retryCount: 1, communicationType: "PRECHECKIN" } });
    const retained = await Promise.all([inbox.retainLabReceipt(lab.prisma, scope, receipt),
      inbox.retainLabReceipt(lab.prisma, scope, receipt)]);
    assert.equal(retained[0], retained[1]);
    assert.equal((await inbox.readLabReceiptInbox(lab.prisma, scope)).retained, 1);
    assert.equal((await inbox.replayLabReceipts(lab.prisma, scope)).processed, 0);
    assert.equal((await inbox.readLabReceiptInbox(lab.prisma, scope)).pending, 1);
    await lab.prisma.messageLog.update({ where: { id: messageId }, data: { providerMessageId: providerId } });

    // A failed processing acknowledgement must roll back the message update too.
    const failing = { $transaction: (work: (tx: any) => Promise<unknown>) => lab.prisma.$transaction(tx => work(
      new Proxy(tx, { get(target, key) {
        if (key === "$executeRaw") return async (query: TemplateStringsArray, ...values: any[]) => {
          if (query.join("").includes("SET processed_at")) throw Error("SYNTHETIC_INBOX_ACK_FAILURE");
          return target.$executeRaw(query, ...values);
        };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      } })
    )) } as unknown as typeof lab.prisma;
    await assert.rejects(inbox.replayLabReceipts(failing, scope), /SYNTHETIC_INBOX_ACK_FAILURE/);
    assert.equal((await lab.prisma.messageLog.findUniqueOrThrow({ where: { id: messageId } })).deliveredAt, null);
    assert.equal((await inbox.readLabReceiptInbox(lab.prisma, scope)).pending, 1);

    await lab.prisma.$disconnect();
    const script = `
      const isolation = await import('./src/guest-journey-lab/isolation.ts');
      isolation.assertLabEnvironment(process.env); isolation.installLabNetworkFence();
      const { PrismaClient } = await import('@prisma/client');
      const { replayLabReceipts } = await import('./src/guest-journey-lab/receipt-inbox.ts');
      const db = new PrismaClient();
      try { const result = await replayLabReceipts(db, ${JSON.stringify(scope)});
        if (result.processed !== 1 || result.providerCalls !== 0) throw Error('REPLAY_NOT_CONFIRMED');
      } finally { await db.$disconnect(); }
    `;
    execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script],
      { env: process.env, timeout: 30000, stdio: "pipe" });
    await lab.prisma.$connect();
    const delivered = await lab.prisma.messageLog.findUniqueOrThrow({ where: { id: messageId } });
    assert.equal(delivered.providerDeliveryStatus, "DELIVERED");
    assert.equal(delivered.status, "E7_SENDING", "receipt persistence does not own workflow completion");
    assert.equal(delivered.retryCount, 1);
    assert.equal(+delivered.deliveredAt!, +eventAt);
    assert.equal((await inbox.readLabReceiptInbox(lab.prisma, scope)).processed, 1);
    assert.equal((await inbox.replayLabReceipts(lab.prisma, scope)).processed, 0);

    await record(lab.prisma, { ...receipt, eventAt: new Date(+eventAt - 1000), deliveredAt: new Date(+eventAt - 1000) });
    const stale = await lab.prisma.messageLog.findUniqueOrThrow({ where: { id: messageId } });
    assert.equal(+stale.providerStatusUpdatedAt!, +eventAt);
    assert.equal(+stale.deliveredAt!, +eventAt);
    const race = await Promise.allSettled([
      record(lab.prisma, { ...receipt, status: "READ", eventAt: new Date(+eventAt + 1000) }),
      record(lab.prisma, { ...receipt, status: "SENT", eventAt: new Date(+eventAt + 2000), deliveredAt: null }),
    ]);
    assert.ok(race.every(result => result.status === "fulfilled"));
    assert.equal((await lab.prisma.messageLog.findUniqueOrThrow({ where: { id: messageId } })).providerDeliveryStatus, "READ");

    // An ambiguous identifier is retained for investigation, never assigned arbitrarily.
    await lab.prisma.messageLog.create({ data: { id: `${messageId}_duplicate`, ...scope,
      channel: "sms", provider: "twilio", providerMessageId: providerId,
      to: "+15005550006", body: "Synthetic ambiguous correlation", status: "E7_SENDING" } });
    await inbox.retainLabReceipt(lab.prisma, scope, { ...receipt, status: "READ", eventAt: new Date(+eventAt + 3000) });
    assert.equal((await inbox.replayLabReceipts(lab.prisma, scope)).processed, 0);
    assert.equal((await inbox.readLabReceiptInbox(lab.prisma, scope)).pending, 1);
    await assert.rejects(inbox.retainLabReceipt(lab.prisma, { ...scope, organizationId: "other" }, receipt), /SCOPE_REJECTED/);
    await assert.rejects(inbox.retainLabReceipt(lab.prisma, scope, { ...receipt, eventAt: new Date(NaN) }), /RECEIPT_INVALID/);
    assert.equal(await lab.prisma.$queryRaw<Array<{ count: number }>>`SELECT COUNT(*)::int AS count
      FROM guest_journey_lab.provider_call WHERE message_id=${messageId}`.then(rows => rows[0].count), 0);
  } finally {
    await lab.prisma.$executeRaw`DELETE FROM guest_journey_lab.receipt_inbox WHERE property_id=${scope.propertyId}`;
    await lab.prisma.messageLog.deleteMany({ where: { propertyId: scope.propertyId } });
    await lab.prisma.property.delete({ where: { id: scope.propertyId } });
  }
});


test("captured early receipts recover through E7 to final delivery without repeating sends", async t => {
  const producer = await import("./precheckin-first-send");
  const probe = await import("./precheckin-first-send.runtime");
  const { recoverDeliveryReceipts } = await import("../services/message-delivery-receipt-recovery.service");
  const previous = process.env.MESSAGE_DELIVERY_ACCOUNT_BINDING_ENABLED;
  t.after(() => {
    if (previous === undefined) delete process.env.MESSAGE_DELIVERY_ACCOUNT_BINDING_ENABLED;
    else process.env.MESSAGE_DELIVERY_ACCOUNT_BINDING_ENABLED = previous;
  });
  process.env.MESSAGE_DELIVERY_ACCOUNT_BINDING_ENABLED = "1";
  const revision = lab.fixtureRevision + "_captured";
  await lab.prepareLabTables();
  await probe.seedFirstSend(lab.prisma, revision);
  await probe.materializeFirstSendFixtures(lab.prisma, revision);
  const scope = producer.firstSendScope(revision);
  const reservationId = producer.firstSendReservationId(revision, "before_arrival");
  assert.equal((await probe.dispatchFirstSend(lab.prisma, revision, true)).errors, 0);
  const messages = await lab.prisma.messageLog.findMany({where: {...scope, reservationId}});
  assert.equal(messages.length, 2);
  const intents = await lab.prisma.guestJourneyCoordinationIntent.findMany({where: {reservationId}});
  assert.equal(intents.length, 2);
  for (const message of messages) {
    assert.ok(message.providerAccountKey);
    assert.ok(message.providerMessageId);
    assert.equal(message.deliveredAt, null);
    assert.equal(message.status, "E7_SENDING");
  }
  for (const intent of intents) {
    assert.equal(intent.status, "WAITING_FOR_EVIDENCE");
    assert.equal((await reconcile(lab.prisma, {...scope, intentId: intent.id})).action, "WAITING");
  }
  const before = await probe.readFirstSendEvidence(lab.prisma, revision);
  await lab.prisma.$disconnect(); await lab.prisma.$connect();
  const result = await recoverDeliveryReceipts(lab.prisma, {MESSAGE_DELIVERY_RECEIPT_RECOVERY_MODE: "APPLY"});
  assert.equal(result.providerCalls, 0);
  for (const message of messages) {
    const receipt = await lab.prisma.messageDeliveryReceipt.findFirstOrThrow({where: {providerMessageId: message.providerMessageId!}});
    assert.ok(receipt.processedAt);
    assert.equal(receipt.processedMessageLogId, message.id);
  }
  for (const intent of intents) {
    assert.equal((await reconcile(lab.prisma, {...scope, intentId: intent.id})).action, "RECOVERED");
    assert.equal((await reconcile(lab.prisma, {...scope, intentId: intent.id})).action, "NOT_REQUIRED");
    assert.equal((await lab.prisma.guestJourneyCoordinationIntent.findUniqueOrThrow({where: {id: intent.id}})).status, "SUCCEEDED");
  }
  await recoverDeliveryReceipts(lab.prisma, {MESSAGE_DELIVERY_RECEIPT_RECOVERY_MODE: "APPLY"});
  await probe.dispatchFirstSend(lab.prisma, revision, true);
  const after = await probe.readFirstSendEvidence(lab.prisma, revision);
  assert.deepEqual(after.calls, before.calls);
  for (const message of messages) {
    const final = await lab.prisma.messageLog.findUniqueOrThrow({where: {id: message.id}});
    assert.equal(final.providerDeliveryStatus, "DELIVERED");
    assert.ok(final.deliveredAt);
  }
  assert.equal(after.realDeliveryCertified, false);
});
