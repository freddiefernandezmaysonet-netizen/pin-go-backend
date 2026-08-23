import assert from "node:assert/strict";
import test from "node:test";
import {
  changeManualReservationDatesByHost,
  previewManualReservationDateChangeByHost,
  type ManualReservationDateChangeDependencies,
} from "./manual-reservation-date-change.service";

const NOW = new Date("2026-08-23T16:00:00.000Z");
const UPDATED_AT = new Date("2026-08-23T15:00:00.000Z");

function reservation(overrides: Record<string, unknown> = {}) {
  return {
    id: "reservation-1",
    reservationNumber: "PG-TEST-1",
    source: "MANUAL",
    status: "ACTIVE",
    checkIn: new Date("2026-09-10T20:00:00.000Z"),
    checkOut: new Date("2026-09-12T15:00:00.000Z"),
    updatedAt: UPDATED_AT,
    totalAmount: 200,
    currency: "usd",
    propertyId: "property-1",
    selectedAmenityIds: [],
    property: {
      organizationId: "org-1",
      timezone: "America/Puerto_Rico",
      checkInTime: "16:00",
      checkOutTime: "11:00",
      distributionEnabled: true,
      distributionStatus: "ACTIVE",
    },
    ...overrides,
  };
}

function cloneReservation(value: any) {
  return {
    ...value,
    checkIn: new Date(value.checkIn),
    checkOut: new Date(value.checkOut),
    updatedAt: new Date(value.updatedAt),
    selectedAmenityIds: [...(value.selectedAmenityIds ?? [])],
    property: { ...value.property },
  };
}

function harness(options: {
  reservation?: any;
  proposedTotal?: number;
  loseAtomicFence?: boolean;
  channexFailure?: boolean;
} = {}) {
  const calls = {
    writes: 0,
    casAttempts: 0,
    postUpdateReads: 0,
    channex: 0,
    reconcile: 0,
    transactions: 0,
    rollbacks: 0,
    pricing: 0,
  };
  let persisted = cloneReservation(options.reservation ?? reservation());
  let reads = 0;
  let transactionState: any = null;
  let lastCasWhere: any = null;

  const tx = {
    reservation: {
      updateMany: async ({ where, data }: any) => {
        calls.casAttempts += 1;
        lastCasWhere = where;
        if (options.loseAtomicFence) return { count: 0 };
        if (
          where?.id !== transactionState.id ||
          new Date(where?.updatedAt).toISOString() !== transactionState.updatedAt.toISOString()
        ) {
          return { count: 0 };
        }
        calls.writes += 1;
        transactionState = {
          ...transactionState,
          ...data,
          updatedAt: new Date(NOW),
        };
        return { count: 1 };
      },
      findUnique: async () => {
        calls.postUpdateReads += 1;
        return {
          id: transactionState.id,
          reservationNumber: transactionState.reservationNumber,
          checkIn: transactionState.checkIn,
          checkOut: transactionState.checkOut,
          totalAmount: transactionState.totalAmount,
          currency: transactionState.currency,
        };
      },
    },
  };

  const dependencies: ManualReservationDateChangeDependencies = {
    prisma: {
      reservation: {
        findFirst: async () => {
          reads += 1;
          return reads % 2 === 1 ? cloneReservation(persisted) : null;
        },
      },
      $transaction: async (fn: any) => {
        calls.transactions += 1;
        const before = cloneReservation(persisted);
        transactionState = cloneReservation(persisted);
        try {
          const result = await fn(tx);
          persisted = cloneReservation(transactionState);
          return result;
        } catch (error) {
          calls.rollbacks += 1;
          persisted = before;
          throw error;
        } finally {
          transactionState = null;
        }
      },
    },
    calculatePricing: async () => {
      calls.pricing += 1;
      return {
        nights: 3,
        nightlyRates: [],
        nightlySubtotal: options.proposedTotal ?? 300,
        cleaningFee: 0,
        amenitiesTotal: 0,
        taxesTotal: 0,
        taxableSubtotal: options.proposedTotal ?? 300,
        totalAmount: options.proposedTotal ?? 300,
        currency: "usd",
      } as any;
    },
    persistChannexIntent: async () => {
      calls.channex += 1;
      if (options.channexFailure) throw new Error("simulated transactional Channex intent failure");
      return {} as any;
    },
    reconcile: async () => {
      calls.reconcile += 1;
      return {} as any;
    },
    now: () => new Date(NOW),
  };

  return {
    dependencies,
    calls,
    state: () => cloneReservation(persisted),
    lastCasWhere: () => lastCasWhere,
  };
}

const dates = {
  organizationId: "org-1",
  reservationId: "reservation-1",
  checkInDate: "2026-09-10",
  checkOutDate: "2026-09-13",
};

test("preview is behaviorally read-only", async () => {
  const { dependencies, calls, state } = harness();
  const before = state();
  const result = await previewManualReservationDateChangeByHost(dates, dependencies);
  assert.equal(result.ok, true);
  assert.equal(result.preview.current.totalAmount, 200);
  assert.equal(result.preview.proposed.totalAmount, 300);
  assert.equal(result.preview.difference, 100);
  assert.equal(calls.pricing, 1);
  assert.equal(calls.transactions, 0);
  assert.equal(calls.casAttempts, 0);
  assert.equal(calls.writes, 0);
  assert.equal(calls.channex, 0);
  assert.equal(calls.reconcile, 0);
  assert.deepEqual(state(), before);
});

test("stale reservation version rejects before opening a transaction", async () => {
  const { dependencies, calls } = harness();
  await assert.rejects(
    changeManualReservationDatesByHost({
      ...dates,
      requestedByUserId: "user-1",
      expectedReservationUpdatedAt: "2026-08-23T14:00:00.000Z",
      expectedProposedTotalAmount: 300,
    }, dependencies),
    (error: any) => error?.code === "RESERVATION_CHANGED_REVIEW_REQUIRED" && error?.statusCode === 409,
  );
  assert.equal(calls.transactions, 0);
  assert.equal(calls.casAttempts, 0);
  assert.equal(calls.writes, 0);
  assert.equal(calls.channex, 0);
  assert.equal(calls.reconcile, 0);
});

test("stale reviewed price rejects before opening a transaction", async () => {
  const { dependencies, calls } = harness({ proposedTotal: 325 });
  await assert.rejects(
    changeManualReservationDatesByHost({
      ...dates,
      requestedByUserId: "user-1",
      expectedReservationUpdatedAt: UPDATED_AT.toISOString(),
      expectedProposedTotalAmount: 300,
    }, dependencies),
    (error: any) => error?.code === "PRICING_CHANGED_REVIEW_REQUIRED" && error?.statusCode === 409,
  );
  assert.equal(calls.transactions, 0);
  assert.equal(calls.casAttempts, 0);
  assert.equal(calls.writes, 0);
  assert.equal(calls.channex, 0);
  assert.equal(calls.reconcile, 0);
});

test("lost atomic version fence rolls back with zero side effects", async () => {
  const { dependencies, calls, state, lastCasWhere } = harness({ loseAtomicFence: true });
  const before = state();
  await assert.rejects(
    changeManualReservationDatesByHost({
      ...dates,
      requestedByUserId: "user-1",
      expectedReservationUpdatedAt: UPDATED_AT.toISOString(),
      expectedProposedTotalAmount: 300,
    }, dependencies),
    (error: any) => error?.code === "RESERVATION_CHANGED_REVIEW_REQUIRED" && error?.statusCode === 409,
  );
  assert.deepEqual(lastCasWhere(), {
    id: "reservation-1",
    updatedAt: UPDATED_AT,
  });
  assert.equal(calls.transactions, 1);
  assert.equal(calls.rollbacks, 1);
  assert.equal(calls.casAttempts, 1);
  assert.equal(calls.writes, 0);
  assert.equal(calls.postUpdateReads, 0);
  assert.equal(calls.channex, 0);
  assert.equal(calls.reconcile, 0);
  assert.deepEqual(state(), before);
});

test("transactional Channex failure rolls back the reservation and skips reconciliation", async () => {
  const { dependencies, calls, state } = harness({ channexFailure: true });
  const before = state();
  await assert.rejects(
    changeManualReservationDatesByHost({
      ...dates,
      requestedByUserId: "user-1",
      expectedReservationUpdatedAt: UPDATED_AT.toISOString(),
      expectedProposedTotalAmount: 300,
    }, dependencies),
    /simulated transactional Channex intent failure/,
  );
  assert.equal(calls.transactions, 1);
  assert.equal(calls.rollbacks, 1);
  assert.equal(calls.casAttempts, 1);
  assert.equal(calls.writes, 1);
  assert.equal(calls.channex, 1);
  assert.equal(calls.reconcile, 0);
  assert.deepEqual(state(), before);
});

test("valid confirmation performs one atomic mutation, one Channex intent, and one reconciliation", async () => {
  const { dependencies, calls, state, lastCasWhere } = harness();
  const result = await changeManualReservationDatesByHost({
    ...dates,
    requestedByUserId: "user-1",
    expectedReservationUpdatedAt: UPDATED_AT.toISOString(),
    expectedProposedTotalAmount: 300,
  }, dependencies);
  assert.equal(result.ok, true);
  assert.equal(result.pricing.proposedTotalAmount, 300);
  assert.deepEqual(lastCasWhere(), {
    id: "reservation-1",
    updatedAt: UPDATED_AT,
  });
  assert.equal(calls.transactions, 1);
  assert.equal(calls.rollbacks, 0);
  assert.equal(calls.casAttempts, 1);
  assert.equal(calls.writes, 1);
  assert.equal(calls.postUpdateReads, 1);
  assert.equal(calls.channex, 1);
  assert.equal(calls.reconcile, 1);
  assert.equal(state().totalAmount, 300);
  assert.equal(state().checkOut.toISOString(), "2026-09-13T15:00:00.000Z");
});
