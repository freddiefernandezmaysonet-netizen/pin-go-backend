import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

async function readIngestService() {
  return readFile(new URL("./ingest.service.ts", import.meta.url), "utf8");
}

test("cancelled reservations exit before arrival preparation", async () => {
  const source = await readIngestService();
  const cancellationGuard = source.indexOf(
    "if (reservation.status === ReservationStatus.CANCELLED)"
  );
  const guestJourneyCall = source.indexOf(
    "await ensureGuestJourneyForConfirmedReservation"
  );

  assert.notEqual(cancellationGuard, -1);
  assert.notEqual(guestJourneyCall, -1);
  assert.ok(cancellationGuard < guestJourneyCall);
  assert.match(
    source.slice(cancellationGuard, guestJourneyCall),
    /cancelled:\s*true/
  );
});

test("cancelled reservations reconcile and skip active-stay preparation", async () => {
  const source = await readIngestService();
  const cancellationResultGuard = source.indexOf("if (result.cancelled)");
  const guestAgreementPreparation = source.indexOf(
    "const guestAgreementSnapshotResult"
  );

  assert.notEqual(cancellationResultGuard, -1);
  assert.notEqual(guestAgreementPreparation, -1);
  assert.ok(cancellationResultGuard < guestAgreementPreparation);

  const cancellationBranch = source.slice(
    cancellationResultGuard,
    guestAgreementPreparation
  );

  assert.match(
    cancellationBranch,
    /await reconcileReservation\(result\.reservationId\)/
  );
  assert.match(cancellationBranch, /return \{\s*\.\.\.result,\s*auditEntry/);
});
