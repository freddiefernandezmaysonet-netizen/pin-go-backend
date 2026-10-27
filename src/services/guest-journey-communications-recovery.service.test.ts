import assert from "node:assert/strict";
import test from "node:test";
import { hasConfirmedCommunicationReceipt } from "./guest-journey-communications-recovery.service";

const started = new Date("2026-10-27T10:00:00Z");
const delivered = new Date("2026-10-27T10:01:00Z");
const now = new Date("2026-10-27T10:02:00Z");
const evidence = { status: "E7_SENDING", channel: "sms", provider: "twilio", providerMessageId: "SM-test",
  providerDeliveryStatus: "DELIVERED", providerStatusUpdatedAt: delivered, deliveredAt: delivered };

test("only a confirmed receipt for the channel's canonical provider can close uncertainty", () => {
  assert.equal(hasConfirmedCommunicationReceipt(evidence, started, now), true);
  assert.equal(hasConfirmedCommunicationReceipt({ ...evidence, channel: "email", provider: "resend" }, started, now), true);
  assert.equal(hasConfirmedCommunicationReceipt({ ...evidence, providerDeliveryStatus: "READ" }, started, now), true);
  for (const patch of [
    { providerMessageId: null }, { providerMessageId: " " }, { provider: "other" },
    { channel: "push" }, { deliveredAt: null }, { providerStatusUpdatedAt: null },
    { status: "FAILED" }, { status: "OBSOLETE" },
  ]) assert.equal(hasConfirmedCommunicationReceipt({ ...evidence, ...patch }, started, now), false);
});

test("acceptance, transit and failure receipts never certify delivery", () => {
  for (const status of ["ACCEPTED", "SENT", "QUEUED", "SENDING", "DELIVERY_DELAYED", "FAILED", "UNDELIVERED", "BOUNCED", "SUPPRESSED", "COMPLAINED", "CANCELED", null]) {
    assert.equal(hasConfirmedCommunicationReceipt({ ...evidence, providerDeliveryStatus: status }, started, now), false);
  }
});

test("old, future, invalid and contradictory receipt dates remain unresolved", () => {
  for (const patch of [
    { deliveredAt: new Date(started.getTime() - 1) },
    { deliveredAt: new Date("invalid") },
    { providerStatusUpdatedAt: new Date(now.getTime() + 1) },
    { providerStatusUpdatedAt: started },
  ]) assert.equal(hasConfirmedCommunicationReceipt({ ...evidence, ...patch }, started, now), false);
});
