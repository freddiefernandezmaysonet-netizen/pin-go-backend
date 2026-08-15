import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

async function readReservationCompleteFlowAuditService() {
  return readFile(
    new URL("./reservation-complete-flow-audit.service.ts", import.meta.url),
    "utf8"
  );
}

test("cancelled reservations use terminal audit evidence distinct from readiness", async () => {
  const source = await readReservationCompleteFlowAuditService();

  assert.match(source, /decisionId\?: string/);
  assert.match(
    source,
    /input\.decisionId \?\?\s*`reservation-complete-flow:\$\{input\.reservationId\}`/
  );
  assert.match(
    source,
    /terminalDecisionId =\s*`reservation-complete-flow-cancelled:\$\{reservation\.id\}`/
  );
  assert.match(
    source,
    /buildAuditEntry\(\{[\s\S]*?decisionId: terminalDecisionId/
  );
});

test("terminal cancellation audit is deterministic across retries", async () => {
  const source = await readReservationCompleteFlowAuditService();
  const cancelledBranchStart = source.indexOf(
    "reservation.status ===\n    ReservationStatus.CANCELLED"
  );
  const cancelledBranchEnd = source.indexOf(
    "const auditSource = normalizeText",
    cancelledBranchStart
  );

  assert.notEqual(cancelledBranchStart, -1);
  assert.notEqual(cancelledBranchEnd, -1);

  const cancelledBranch = source.slice(
    cancelledBranchStart,
    cancelledBranchEnd
  );

  assert.match(
    cancelledBranch,
    /terminalOccurredAt =\s*reservation\.cancelledAt \?\? reservation\.updatedAt/
  );
  assert.match(
    cancelledBranch,
    /startedAt: terminalOccurredAt/
  );
  assert.match(
    cancelledBranch,
    /completedAt: terminalOccurredAt/
  );
  assert.doesNotMatch(cancelledBranch, /const completedAt = new Date\(\)/);
});

test("cancelled operational resolution references the terminal audit decision", async () => {
  const source = await readReservationCompleteFlowAuditService();
  const cancelledBranchStart = source.indexOf(
    "reservation.status ===\n    ReservationStatus.CANCELLED"
  );
  const cancelledBranchEnd = source.indexOf(
    "const auditSource = normalizeText",
    cancelledBranchStart
  );
  const cancelledBranch = source.slice(
    cancelledBranchStart,
    cancelledBranchEnd
  );

  assert.match(
    cancelledBranch,
    /resolveOperationalIssuesForReservation\([\s\S]*?decisionId: terminalDecisionId/
  );
  assert.match(
    cancelledBranch,
    /occurredAt: terminalOccurredAt/
  );
  assert.doesNotMatch(
    cancelledBranch,
    /decisionId:\s*`reservation-complete-flow:\$\{reservation\.id\}`/
  );
});
