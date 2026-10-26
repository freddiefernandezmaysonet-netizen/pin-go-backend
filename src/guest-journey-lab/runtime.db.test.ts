import assert from "node:assert/strict";
import test from "node:test";
import { assertLabEnvironment, installLabNetworkFence } from "./isolation";

assertLabEnvironment(process.env);
installLabNetworkFence();
const lab = await import("./runtime");
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
  assert.equal(first.intents.filter(intent => intent.status === "WAITING_FOR_EVIDENCE").length, 2);
  assert.equal(first.durableAttempts, 4);
  assert.deepEqual(first.calls, [
    { scenario: "accepted", calls: 1 }, { scenario: "empty_ack", calls: 1 }, { scenario: "timeout", calls: 1 },
  ]);
  // Re-seeding and repeating ticks must not reset durable attempts or messages.
  await lab.seedLabFixtures();
  await lab.runCommunicationsProbe();
  await lab.prisma.$disconnect();
  await lab.prisma.$connect();
  await lab.runCommunicationsProbe();
  const replay = await lab.readLabEvidence();
  assert.deepEqual(replay.calls, first.calls);
  assert.equal(replay.durableAttempts, first.durableAttempts);
  assert.equal(await lab.prisma.guestJourneyCoordinationIntent.count({ where: {
    targetEngine: { not: "COMMUNICATIONS" }, claimCount: { gt: 0 },
  } }), 0, "no other Owner may claim an intent");
  assert.equal(replay.productionReady, false);
});
