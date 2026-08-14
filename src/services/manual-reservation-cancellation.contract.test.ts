import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

async function readManualCancellationService() {
  return readFile(
    new URL("./manual-reservation-cancellation.service.ts", import.meta.url),
    "utf8"
  );
}

test("host cancellation is restricted to host-created manual reservations", async () => {
  const source = await readManualCancellationService();

  assert.match(
    source,
    /reservation\.source[\s\S]*?toUpperCase\(\) === "MANUAL"/
  );
  assert.match(
    source,
    /reservation\.externalProvider[\s\S]*?toUpperCase\(\) ===[\s\S]*?"PIN_GO_MANUAL"/
  );
  assert.match(source, /NOT_HOST_CREATED_MANUAL_RESERVATION/);
  assert.doesNotMatch(source, /DIRECT_BOOKING|CHANNEX|AIRBNB|VRBO/);
});

test("reservation lookup is isolated by authenticated organization", async () => {
  const source = await readManualCancellationService();

  assert.match(
    source,
    /findFirst\(\{[\s\S]*?id:\s*cleanReservationId[\s\S]*?property:\s*\{[\s\S]*?organizationId:\s*cleanOrganizationId/
  );
  assert.match(source, /code:\s*"RESERVATION_NOT_FOUND"/);
});

test("host identity and cancellation reason are required", async () => {
  const source = await readManualCancellationService();

  assert.match(
    source,
    /normalizeRequiredText\(reason,\s*"reason"\)/
  );
  assert.match(
    source,
    /normalizeRequiredText\([\s\S]*?requestedByUserId,[\s\S]*?"requestedByUserId"/
  );
  assert.match(source, /MISSING_\$\{field\.toUpperCase\(\)\}/);
});

test("cancellation records the host actor without changing manual payment state", async () => {
  const source = await readManualCancellationService();
  const updateStart = source.indexOf(
    "const cancellationUpdate = await tx.reservation.updateMany"
  );
  const updateEnd = source.indexOf(
    "const persistedReservation = await tx.reservation.findUnique",
    updateStart
  );

  assert.notEqual(updateStart, -1);
  assert.notEqual(updateEnd, -1);
  assert.ok(updateStart < updateEnd);

  const cancellationUpdate = source.slice(updateStart, updateEnd);

  assert.match(
    cancellationUpdate,
    /status:\s*ReservationStatus\.CANCELLED/
  );
  assert.match(
    cancellationUpdate,
    /cancelledBy:\s*CancellationActor\.HOST/
  );
  assert.match(
    cancellationUpdate,
    /cancelledByUserId:\s*cleanRequestedByUserId/
  );
  assert.match(
    cancellationUpdate,
    /cancellationRequestedBy:\s*CancellationActor\.HOST/
  );
  assert.match(
    cancellationUpdate,
    /cancellationReason:\s*cleanReason/
  );
  assert.doesNotMatch(cancellationUpdate, /paymentState/);
  assert.doesNotMatch(cancellationUpdate, /hostPayoutStatus/);
  assert.doesNotMatch(cancellationUpdate, /cancellationRefund/);
  assert.doesNotMatch(source, /stripe/i);
});

test("already cancelled reservations return idempotently without replaying operations", async () => {
  const source = await readManualCancellationService();
  const cancelledGuard = source.indexOf(
    "reservation.status === ReservationStatus.CANCELLED"
  );
  const updateCall = source.indexOf(
    "const cancellationUpdate = await tx.reservation.updateMany"
  );
  const idempotentResponse = source.indexOf(
    "alreadyCancelled: true"
  );
  const finalizationCall = source.indexOf(
    "await finalizeManualCancellationOperationsSafe"
  );

  assert.notEqual(cancelledGuard, -1);
  assert.notEqual(updateCall, -1);
  assert.notEqual(idempotentResponse, -1);
  assert.notEqual(finalizationCall, -1);
  assert.ok(cancelledGuard < updateCall);
  assert.ok(idempotentResponse < finalizationCall);

  const idempotentBranch = source.slice(
    source.indexOf("if (!cancellationResult.didCancel)"),
    finalizationCall
  );

  assert.match(idempotentBranch, /alreadyCancelled:\s*true/);
  assert.match(idempotentBranch, /skipped:\s*true/);
  assert.doesNotMatch(
    idempotentBranch,
    /finalizeManualCancellationOperationsSafe\(/
  );
});

test("operational finalization uses canonical reservation lifecycle services", async () => {
  const source = await readManualCancellationService();

  assert.match(
    source,
    /await reconcileReservation\(input\.reservationId\)/
  );
  assert.match(
    source,
    /resolveOperationalIssuesForReservation\(prisma/
  );
  assert.match(
    source,
    /resolvedBy:\s*"HOST"/
  );
  assert.match(
    source,
    /auditReservationCompleteFlowSafe\(input\.reservationId, prisma\)/
  );
  assert.doesNotMatch(source, /ttlockChangeCardPeriod/);
  assert.doesNotMatch(source, /ttlockCreatePasscode/);
  assert.doesNotMatch(source, /ttlockDeletePasscode/);
});

test("pending cleaning confirmations close without inventing a refund", async () => {
  const source = await readManualCancellationService();

  assert.match(
    source,
    /cleaningConfirmation\.updateMany\(\{[\s\S]*?reservationId:\s*input\.reservationId[\s\S]*?status:\s*"PENDING"[\s\S]*?status:\s*"CANCELLED"/
  );
  assert.doesNotMatch(source, /refundDirectBookingReservation/);
  assert.doesNotMatch(source, /refundAmount/);
});

test("new manual cancellation sends the guest email through logged delivery", async () => {
  const source = await readManualCancellationService();
  const finalizationStart = source.indexOf(
    "async function finalizeManualCancellationOperationsSafe"
  );
  const cancellationFunctionStart = source.indexOf(
    "export async function cancelManualReservationByHost",
    finalizationStart
  );
  const finalization = source.slice(
    finalizationStart,
    cancellationFunctionStart
  );

  assert.match(
    finalization,
    /if \(reservation\?\.guestEmail\)/
  );
  assert.match(
    finalization,
    /resolveOrganizationGuestReplyTo\(/
  );
  assert.match(
    finalization,
    /sendLoggedEmail\(\{[\s\S]*?type:\s*"MANUAL_RESERVATION_GUEST_CANCELLATION"/
  );
  assert.match(
    finalization,
    /sendManualReservationGuestCancellationEmail\(/
  );
  assert.match(
    finalization,
    /operation:\s*"GUEST_CANCELLATION_EMAIL"/
  );
});

test("guest cancellation retry payload contains no token or financial fields", async () => {
  const source = await readManualCancellationService();
  const retryStart = source.indexOf(
    "type: \"MANUAL_RESERVATION_GUEST_CANCELLATION\""
  );
  const sendStart = source.indexOf(
    "send: () =>",
    retryStart
  );

  assert.notEqual(retryStart, -1);
  assert.notEqual(sendStart, -1);

  const loggedDelivery = source.slice(
    retryStart,
    sendStart
  );

  assert.match(loggedDelivery, /retryPayload:/);
  assert.match(loggedDelivery, /reservationNumber/);
  assert.match(loggedDelivery, /preferredLanguage/);
  assert.doesNotMatch(loggedDelivery, /guestToken/);
  assert.doesNotMatch(loggedDelivery, /stripe/i);
  assert.doesNotMatch(loggedDelivery, /refund/i);
  assert.doesNotMatch(loggedDelivery, /paymentState/);
});

test("idempotent cancellation returns before guest communication finalization", async () => {
  const source = await readManualCancellationService();
  const idempotentStart = source.indexOf(
    "if (!cancellationResult.didCancel)"
  );
  const finalizationCall = source.indexOf(
    "await finalizeManualCancellationOperationsSafe",
    idempotentStart
  );

  assert.notEqual(idempotentStart, -1);
  assert.notEqual(finalizationCall, -1);

  const idempotentBranch = source.slice(
    idempotentStart,
    finalizationCall
  );

  assert.match(
    idempotentBranch,
    /alreadyCancelled:\s*true/
  );
  assert.match(idempotentBranch, /skipped:\s*true/);
  assert.doesNotMatch(
    idempotentBranch,
    /sendLoggedEmail/
  );
  assert.doesNotMatch(
    idempotentBranch,
    /sendManualReservationGuestCancellationEmail/
  );
});
