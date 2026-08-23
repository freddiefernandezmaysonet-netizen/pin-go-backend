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

function harness(options: { reservation?: any; proposedTotal?: number } = {}) {
  const calls = { writes: 0, channex: 0, reconcile: 0, transactions: 0, pricing: 0 };
  const current = options.reservation ?? reservation();
  let reads = 0;
  const tx = {
    reservation: {
      update: async ({ data }: any) => {
        calls.writes += 1;
        return {
          id: current.id,
          reservationNumber: current.reservationNumber,
          checkIn: data.checkIn,
          checkOut: data.checkOut,
          totalAmount: data.totalAmount,
          currency: data.currency,
        };
      },
    },
  };
  const dependencies: ManualReservationDateChangeDependencies = {
    prisma: {
      reservation: {
        findFirst: async () => {
          reads += 1;
          return reads % 2 === 1 ? current : null;
        },
      },
      $transaction: async (fn: any) => {
        calls.transactions += 1;
        return fn(tx);
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
    persistChannexIntent: async () => { calls.channex += 1; return {} as any; },
    reconcile: async () => { calls.reconcile += 1; return {} as any; },
    now: () => new Date(NOW),
  };
  return { dependencies, calls };
}

const dates = {
  organizationId: "org-1",
  reservationId: "reservation-1",
  checkInDate: "2026-09-10",
  checkOutDate: "2026-09-13",
};

test("preview is behaviorally read-only", async () => {
  const { dependencies, calls } = harness();
  const result = await previewManualReservationDateChangeByHost(dates, dependencies);
  assert.equal(result.ok, true);
  assert.equal(result.preview.current.totalAmount, 200);
  assert.equal(result.preview.proposed.totalAmount, 300);
  assert.equal(result.preview.difference, 100);
  assert.equal(calls.pricing, 1);
  assert.equal(calls.transactions, 0);
  assert.equal(calls.writes, 0);
  assert.equal(calls.channex, 0);
  assert.equal(calls.reconcile, 0);
});

test("stale reservation version rejects before all writes and side effects", async () => {
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
  assert.equal(calls.writes, 0);
  assert.equal(calls.channex, 0);
  assert.equal(calls.reconcile, 0);
});

test("stale reviewed price rejects before all writes and side effects", async () => {
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
  assert.equal(calls.writes, 0);
  assert.equal(calls.channex, 0);
  assert.equal(calls.reconcile, 0);
});

test("valid confirmation performs one mutation, one Channex intent, and one reconciliation", async () => {
  const { dependencies, calls } = harness();
  const result = await changeManualReservationDatesByHost({
    ...dates,
    requestedByUserId: "user-1",
    expectedReservationUpdatedAt: UPDATED_AT.toISOString(),
    expectedProposedTotalAmount: 300,
  }, dependencies);
  assert.equal(result.ok, true);
  assert.equal(result.pricing.proposedTotalAmount, 300);
  assert.equal(calls.transactions, 1);
  assert.equal(calls.writes, 1);
  assert.equal(calls.channex, 1);
  assert.equal(calls.reconcile, 1);
});
