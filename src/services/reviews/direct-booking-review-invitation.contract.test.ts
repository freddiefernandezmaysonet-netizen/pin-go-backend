import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const directBooking = await readFile(new URL("../direct-booking.service.ts", import.meta.url), "utf8");
const dispatcher = await readFile(new URL("./review-invitation-dispatch.service.ts", import.meta.url), "utf8");
const worker = await readFile(new URL("../../workers/review-invitation.worker.ts", import.meta.url), "utf8");

test("reservation confirmation never creates or delivers a review invitation", () => {
  assert.doesNotMatch(directBooking, /ReviewInvitation|reviewsE1Enabled|reviewUrl|ReviewToken/);
  assert.match(directBooking, /sendDirectBookingGuestConfirmation/);
});

test("review invitations use a dedicated default-off post-checkout dispatcher", () => {
  assert.match(worker, /reviewInvitationDispatcherEnabled\(\)/);
  assert.match(dispatcher, /REVIEW_INVITATION_DELAY_MS/);
  assert.match(dispatcher, /checkOut: \{ lte: eligibleCheckout \}/);
  assert.match(dispatcher, /source: "DIRECT_BOOKING"/);
  assert.match(dispatcher, /externalProvider: "PIN_GO_DIRECT"/);
  assert.match(dispatcher, /createReviewInvitation\(candidate\.id, now, input\.prisma\)/);
  assert.match(dispatcher, /sendReviewInvitationEmail/);
  assert.doesNotMatch(dispatcher, /sendDirectBookingGuestConfirmation/);
});

test("dispatcher uses a CAS lease, retry delay and bounded attempts", () => {
  assert.match(dispatcher, /deliveryAttemptCount: \{ lt: 5 \}/);
  assert.match(dispatcher, /retryCutoff/);
  assert.match(dispatcher, /deliveryStatus: "PROCESSING"/);
  assert.match(dispatcher, /deliveryLeaseExpiresAt: \{ lte: now \}/);
  assert.match(dispatcher, /deliveryStatus: \{ in: \["PENDING", "FAILED", "PROCESSING"\] \}/);
  assert.match(dispatcher, /if \(lease\.count !== 1\)/);
  assert.match(dispatcher, /markReviewInvitationDelivery\(/);
});

test("review bearer stays out of the durable retry envelope", () => {
  assert.match(dispatcher, /retryPayload: \{ invitationId: invitation\.invitation\.id \}/);
  assert.doesNotMatch(dispatcher, /retryPayload:[^\n]*token/);
  assert.match(dispatcher, /assertReviewInvitationDeliveryFence/);
});
