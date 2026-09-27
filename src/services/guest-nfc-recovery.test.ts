import assert from "node:assert/strict";
import test from "node:test";
import type { PrismaClient } from "@prisma/client";
import { retryPendingNfcSync } from "./nfc-sync.service";
import { GUEST_NFC_GENERIC_FAILURE, guestNfcDueWhere, guestNfcNextRetry, guestNfcRetryable } from "./guest-nfc-recovery.policy";
import { reconcileGuestNfcRecoveryIssues } from "./guest-nfc-recovery-issue.service";
import { ttlockChangeCardPeriod } from "../ttlock/ttlock.card";

const now = new Date("2026-09-27T05:00:00Z");
function fixture() {
  const row = {
    id: "assignment-1", reservationId: "reservation-1", nfcCardId: "card-1", role: "GUEST",
    status: "FAILED", retryCount: 1, lastError: GUEST_NFC_GENERIC_FAILURE,
    updatedAt: new Date("2026-09-26T17:00:00Z"), provisioningStartedAt: null,
    startsAt: new Date("2026-09-26T19:00:00Z"), endsAt: new Date("2026-09-27T15:00:00Z"),
    NfcCard: { ttlockCardId: "123", status: "ASSIGNED" },
    Reservation: { id: "reservation-1", reservationNumber: "TEST-1", status: "ACTIVE",
      propertyId: "property-1", checkIn: new Date("2026-09-26T19:00:00Z"),
      checkOut: new Date("2026-09-28T15:00:00Z"), property: { organizationId: "org-1" } },
  };
  const calls = { hardware: [] as unknown[], updates: [] as any[], queries: [] as any[], issues: 0 };
  let claim = true;
  let conflict = false;
  let providerError: Error | null = null;
  const db = {
    nfcAssignment: {
      findMany: async (query: unknown) => { calls.queries.push(query); return [row]; },
      updateMany: async ({ where }: any) => {
        assert.equal(where.retryCount, row.retryCount);
        assert.equal(where.updatedAt, row.updatedAt);
        const acquired = claim; claim = false; return { count: acquired ? 1 : 0 };
      },
      findFirst: async () => conflict ? { id: "conflicting-assignment" } : null,
      update: async (args: any) => { calls.updates.push(args.data); return {}; },
    },
    nfcCard: { update: async () => ({}) },
    lock: { findFirst: async () => ({ ttlockLockId: 42 }) },
    $transaction: async (actions: Promise<unknown>[]) => Promise.all(actions),
  } as unknown as PrismaClient;
  const deps = {
    changeCardPeriod: async (args: unknown) => { calls.hardware.push(args); if (providerError) throw providerError; return {}; },
    getAccessToken: async () => "test-token",
    reconcileIssues: async () => { calls.issues++; },
  };
  return { row, calls, db, deps, setConflict: () => { conflict = true; },
    failProvider: () => { providerError = new Error("TTLock errcode=1 errmsg=failed or means no"); } };
}

test("observed generic rejection is recoverable, unrelated TTLock failures are not", () => {
  assert.equal(guestNfcRetryable(GUEST_NFC_GENERIC_FAILURE), true);
  assert.equal(guestNfcRetryable("Error: TTLock errcode=10 errmsg=failed or means no"), false);
  assert.equal(guestNfcRetryable("NFC_WINDOW_CONFLICT:other"), false);
  assert.equal(guestNfcRetryable("Error: TTLock errcode=-2012 errmsg=Gateway unavailable"), true);
});

test("backoff and exhaustion are bounded to five total attempts", () => {
  assert.equal(guestNfcNextRetry(1, now)?.getTime(), now.getTime() + 60_000);
  assert.equal(guestNfcNextRetry(4, now)?.getTime(), now.getTime() + 30 * 60_000);
  assert.equal(guestNfcNextRetry(5, now), null);
  assert.equal(guestNfcNextRetry(6, now), null);
  const where = guestNfcDueWhere(now);
  assert.deepEqual(where.Reservation, { status: "ACTIVE", checkOut: { gt: now }, checkIn: { lte: new Date(now.getTime() + 7200000) } });
  assert.equal(JSON.stringify(where).includes('"ACTIVE"'), true);
  assert.equal(JSON.stringify(where).includes('"ENDED"'), false);
});

test("legacy failed guest recovery sends the current extension window and marks ACTIVE only after success", async () => {
  const f = fixture();
  const result = await retryPendingNfcSync(f.db, now, {}, f.deps);
  assert.equal(result.activated, 1);
  assert.equal((f.calls.hardware[0] as any).endDate, f.row.Reservation.checkOut.getTime());
  assert.equal((f.calls.hardware[0] as any).timeoutMs, 20_000);
  assert.equal(f.calls.updates[0].status, "ACTIVE");
  assert.equal(f.calls.updates[0].endsAt, f.row.Reservation.checkOut);
});

test("a provider rejection stays FAILED and becomes retryable, without false provisionedAt", async () => {
  const f = fixture(); f.failProvider();
  const result = await retryPendingNfcSync(f.db, now, {}, f.deps);
  assert.equal(result.failed, 1);
  assert.equal(result.activated, 0);
  assert.equal(f.calls.updates[0].status, "FAILED");
  assert.equal(f.calls.updates[0].lastError, `RETRYABLE: ${GUEST_NFC_GENERIC_FAILURE}`);
  assert.equal(f.calls.updates[0].provisionedAt, undefined);
  assert.equal(f.calls.issues, 1);
});

test("worker/watchdog competing claims produce one provider call", async () => {
  const f = fixture();
  await Promise.all([retryPendingNfcSync(f.db, now, {}, f.deps), retryPendingNfcSync(f.db, now, {}, f.deps)]);
  assert.equal(f.calls.hardware.length, 1);
});

test("overlap validation uses the extended window and prevents provider mutation", async () => {
  const f = fixture(); f.setConflict();
  const result = await retryPendingNfcSync(f.db, now, {}, f.deps);
  assert.equal(result.failed, 1); assert.equal(f.calls.hardware.length, 0);
  assert.match(f.calls.updates[0].lastError, /NFC_WINDOW_CONFLICT/);
  assert.doesNotMatch(f.calls.updates[0].lastError, /^RETRYABLE:/);
});

test("cancelled reservations cannot activate even after selection", async () => {
  const f = fixture(); f.row.Reservation.status = "CANCELLED";
  await retryPendingNfcSync(f.db, now, {}, f.deps);
  assert.equal(f.calls.hardware.length, 0); assert.equal(f.calls.updates[0].status, "ENDED");
});

test("expired windows and retired cards cannot activate", async () => {
  for (const kind of ["expired", "retired"]) {
    const f = fixture();
    if (kind === "expired") f.row.Reservation.checkOut = new Date(now.getTime() - 1);
    else f.row.NfcCard.status = "RETIRED";
    await retryPendingNfcSync(f.db, now, {}, f.deps);
    assert.equal(f.calls.hardware.length, 0);
  }
});

test("reporting failure does not relabel provider-confirmed access as FAILED", async () => {
  const f = fixture();
  f.deps.reconcileIssues = async () => { throw new Error("issue storage unavailable"); };
  await assert.rejects(retryPendingNfcSync(f.db, now, {}, f.deps), /issue storage unavailable/);
  assert.deepEqual(f.calls.updates.map(x => x.status), ["ACTIVE"]);
});

test("guest failure creates HOST action and successful recovery resolves the same operational key", async () => {
  const f = fixture(); let existing: any = null; const writes: any[] = [];
  const db = { nfcAssignment: { findMany: async () => [f.row] }, operationalIssue: {
    findMany: async () => existing ? [{ operationalKey: existing.operationalKey }] : [],
    findUnique: async () => existing,
  } } as unknown as PrismaClient;
  const persist = (async (_db: unknown, input: any) => { writes.push(input); existing = input; }) as any;
  await reconcileGuestNfcRecoveryIssues(db, now, persist);
  assert.equal(writes[0].visibility, "HOST");
  assert.equal(writes[0].workflowState, "ACTION_REQUIRED");
  assert.equal(writes[0].canAutoResolve, true);
  await reconcileGuestNfcRecoveryIssues(db, now, persist);
  assert.equal(writes.length, 1, "same failure does not duplicate an incident");
  f.row.status = "ACTIVE"; f.row.endsAt = f.row.Reservation.checkOut;
  await reconcileGuestNfcRecoveryIssues(db, now, persist);
  assert.equal(writes[1].operationalKey, writes[0].operationalKey);
  assert.equal(writes[1].workflowState, "RESOLVED");
  assert.equal(writes[1].autoResolveStatus, "SUCCEEDED");
});

test("exhaustion and expired stays never claim recovery succeeded", async () => {
  const f = fixture(); f.row.retryCount = 5;
  let existing: any = null; const writes: any[] = [];
  const db = { nfcAssignment: { findMany: async () => [f.row] }, operationalIssue: {
    findMany: async () => [], findUnique: async () => existing,
  } } as unknown as PrismaClient;
  const persist = (async (_db: unknown, input: any) => { writes.push(input); existing = input; }) as any;
  await reconcileGuestNfcRecoveryIssues(db, now, persist);
  assert.equal(writes[0].canAutoResolve, false);
  assert.equal(writes[0].nextAutomaticStep, null);
  f.row.Reservation.checkOut = new Date(now.getTime() - 1);
  await reconcileGuestNfcRecoveryIssues(db, now, persist);
  assert.equal(writes[1].resolutionType, "EXPIRED");
  assert.notEqual(writes[1].autoResolveStatus, "SUCCEEDED");
});

test("incident lifecycle passes the real operational service validation and records transitions", async () => {
  const f = fixture(); let saved: any = null; const transitions: any[] = [];
  const db: any = {
    nfcAssignment: { findMany: async () => [f.row] },
    operationalIssue: {
      findMany: async () => saved ? [{ operationalKey: saved.operationalKey }] : [],
      findUnique: async () => saved,
      upsert: async ({ create, update }: any) => {
        saved = { id: "incident-1", ...(saved ? { ...saved, ...update } : create) }; return saved;
      },
    },
    operationalIssueTransition: { create: async ({ data }: any) => { transitions.push(data); } },
    $executeRawUnsafe: async () => 1,
    $transaction: async (callback: any) => callback(db),
  };
  await reconcileGuestNfcRecoveryIssues(db, now);
  assert.equal(saved.workflowState, "ACTION_REQUIRED");
  f.row.status = "ACTIVE"; f.row.endsAt = f.row.Reservation.checkOut;
  await reconcileGuestNfcRecoveryIssues(db, now);
  assert.equal(saved.workflowState, "RESOLVED");
  assert.equal(saved.canAutoResolve, true);
  assert.deepEqual(transitions.map(t => t.toWorkflowState), ["ACTION_REQUIRED", "RESOLVED"]);
});

test("guest transport timeout aborts the request; legacy callers keep their existing behavior", async (t) => {
  const original = process.env.TTLOCK_CLIENT_ID;
  process.env.TTLOCK_CLIENT_ID = "nfc-unit-test";
  t.after(() => { if (original === undefined) delete process.env.TTLOCK_CLIENT_ID; else process.env.TTLOCK_CLIENT_ID = original; });
  const signals: (AbortSignal | null | undefined)[] = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, input: RequestInit) => {
    signals.push(input.signal);
    return new Response('{"errcode":0}');
  });
  const input = { lockId: 42, cardId: 123, startDate: 1000, endDate: 2000, accessToken: "test-only" };
  await ttlockChangeCardPeriod({ ...input, timeoutMs: 20_000 });
  await ttlockChangeCardPeriod(input);
  assert.ok(signals[0] instanceof AbortSignal);
  assert.equal(signals[1], undefined);
  t.mock.restoreAll();
  t.mock.method(globalThis, "fetch", async (_url: unknown, input: RequestInit) => {
    await new Promise(resolve => setTimeout(resolve, 5));
    input.signal!.throwIfAborted();
    return new Response('{"errcode":0}');
  });
  await assert.rejects(ttlockChangeCardPeriod({ ...input, timeoutMs: 1 }), (error: unknown) => {
    assert.equal((error as Error).name, "TimeoutError");
    assert.equal(guestNfcRetryable(String(error)), true);
    return true;
  });
});
