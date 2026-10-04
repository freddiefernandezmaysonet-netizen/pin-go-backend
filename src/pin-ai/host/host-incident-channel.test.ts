import assert from "node:assert/strict";
import test from "node:test";
import { channelUpdateId, deliverIncidentChannelUpdate, HOST_CHANNEL_UPDATE, incidentChannelDestination } from "./host-incident-channel.service.js";
import { sealHostContent } from "./host-incident-policy.js";

const threadId = "11111111-1111-4111-8111-111111111111", bookingId = "22222222-2222-4222-8222-222222222222";
const env = { PIN_AI_CHANNEX_AUTO_ENABLED: "true", PIN_AI_CHANNEX_AUTO_ORGANIZATION_IDS: "org", PIN_AI_CHANNEX_AUTO_PROPERTY_IDS: "property",
  PIN_AI_CHANNEX_AUTO_START_AT: "2026-10-03T00:00:00Z", PIN_AI_HOST_INCIDENT_KEYS: JSON.stringify({ test: "ab".repeat(32) }), PIN_AI_HOST_INCIDENT_KEY_ID: "test" };
function harness(options: { mismatched?: boolean; revoked?: boolean; closed?: boolean; busy?: boolean; uncertain?: boolean } = {}) {
  const issue = { id: "issue", metadata: { channelSource: "CHANNEX", channelThreadId: threadId, channelBookingId: bookingId } };
  const message = { id: channelUpdateId("event"), communicationType: HOST_CHANNEL_UPDATE, provider: "channex", channel: "ota", to: threadId,
    organizationId: "org", propertyId: "property", reservationId: "reservation", status: "QUEUED", retryCount: 0,
    body: JSON.stringify({ issueId: "issue", eventId: "event", threadId, bookingId }) };
  let sends = 0, receipt: any = null;
  const prisma = { messageLog: { async updateMany({ where, data }: any) {
    if (where.status !== message.status) return { count: 0 };
    Object.assign(message, data, data.retryCount ? { retryCount: message.retryCount + 1 } : {}); return { count: 1 };
  } }, channexHostMessageSend: { async findUnique() { return receipt; } },
  pinAIHostIncidentMessage: { async findFirst({ where }: any) {
    assert.equal(where.kind, "PUBLISH"); assert.equal(where.audience, "GUEST");
    assert.deepEqual(where.thread, { issueId: "issue", organizationId: "org", propertyId: "property", reservationId: "reservation" });
    return { actorId: "host", threadId: "incident-thread", sequence: 1,
      contentCiphertext: sealHostContent(env, "org:incident-thread:1:GUEST", "A technician will visit at 5."), thread: { issue } };
  } }, reservation: { async findFirst({ where }: any) {
    assert.equal(where.property.organizationId, "org"); return { externalProvider: "CHANNEX", externalId: bookingId };
  } }, dashboardUser: { async findFirst() { return options.revoked ? null : { id: "host" }; } } };
  const runtime = { async messages() { return { thread: { bookingId: options.mismatched ? threadId : bookingId, isClosed: !!options.closed, provider: "Airbnb" } }; },
    automation: { async beforeHostReply() { if (options.busy) throw Error("BUSY"); } }, async reply(input: any) {
      sends++; assert.equal(input.threadId, threadId); assert.equal(input.text, "A technician will visit at 5.");
      assert.equal(input.requestKey, "incident-host-event");
      receipt = { propertyId: "property", threadId, status: options.uncertain ? "UNKNOWN" : "SENT", response: { id: "channel-message" } };
      if (options.uncertain) throw Error("UNKNOWN"); return { message: { id: "channel-message" } };
    } };
  const run = () => deliverIncidentChannelUpdate({ prisma: prisma as any, runtime: runtime as any, env, message: structuredClone(message) as any });
  return { run, message, sends: () => sends, setReceipt: (r: any) => { receipt = r; } };
}
test("incident source matches exact booking; portal has no channel destination", () => {
  assert.equal(incidentChannelDestination({ id: "i", metadata: {} }, { externalProvider: null, externalId: null }), null);
  assert.throws(() => incidentChannelDestination({ id: "i", metadata: { channelSource: "CHANNEX", channelThreadId: threadId, channelBookingId: bookingId } },
    { externalProvider: "CHANNEX", externalId: threadId }), /NOT_LINKED/);
});
test("concurrent delivery claims one send and reconciles its canonical receipt", async () => {
  const h = harness(); await Promise.all([h.run(), h.run()]);
  assert.equal(h.sends(), 1); assert.equal(h.message.status, "SENT");
  await h.run(); assert.equal(h.sends(), 1);
});
test("wrong booking, closed thread and revoked host cannot send", async () => {
  for (const option of [{ mismatched: true }, { closed: true }, { revoked: true }]) {
    const h = harness(option); assert.equal(await h.run(), "BLOCKED"); assert.equal(h.sends(), 0);
  }
});
test("busy host fence postpones the queued message without sending", async () => {
  const h = harness({ busy: true }); assert.equal(await h.run(), "QUEUED"); assert.equal(h.message.status, "QUEUED"); assert.equal(h.sends(), 0);
});
test("uncertain send is never automatically replayed", async () => {
  const h = harness({ uncertain: true }); assert.equal(await h.run(), "UNKNOWN");
  await h.run(); assert.equal(h.sends(), 1); assert.equal(h.message.status, "UNKNOWN");
});
test("interrupted send without a receipt becomes uncertain and cannot be resent", async () => {
  const h = harness(); h.message.status = "SENDING"; assert.equal(await h.run(), "UNKNOWN");
  await h.run(); assert.equal(h.sends(), 0);
});
test("accepted canonical receipt recovers final persistence failure without another send", async () => {
  const h = harness(); h.message.status = "SENDING"; h.setReceipt({ propertyId: "property", threadId, status: "SENT", response: { id: "accepted" } });
  assert.equal(await h.run(), "SENT"); assert.equal(h.message.status, "SENT"); assert.equal(h.sends(), 0);
});
