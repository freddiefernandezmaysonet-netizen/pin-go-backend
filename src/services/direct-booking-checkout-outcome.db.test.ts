/** Isolated PostgreSQL fixture: actual decision/case service, minimal DB reservation writer. */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { PrismaClient, type Prisma } from "@prisma/client";
import type Stripe from "stripe";
import {
  recordPaidDirectBookingConflict,
} from "./direct-booking-paid-conflict.service.js";
import {
  assertDirectBookingIngestAvailability,
  runIngestTransaction,
} from "./direct-booking-ingest-transaction";
import {
  claimStripeFinancialEvent,
} from "./stripe-financial-event-ledger.service";

import {
  claimPaidDirectBookingIngest,
  getPaidDirectBookingCheckoutScope,
  PAID_CHECKOUT_REVIEW_WON,
} from "./direct-booking-checkout-outcome.service.js";

function testDatabaseUrl() {
  const configured = process.env.PAID_CONFLICT_TEST_DATABASE_URL;
  assert.ok(configured, "Set PAID_CONFLICT_TEST_DATABASE_URL for disposable localhost PostgreSQL");
  assert.equal(process.env.DATABASE_URL, configured, "Both datasource declarations must be the same isolated test URL");
  const target = new URL(configured);
  assert.equal(target.protocol, "postgresql:");
  assert.ok(["127.0.0.1", "localhost"].includes(target.hostname), "Refusing non-local PostgreSQL");
  assert.equal(target.pathname, "/pingo_paid_conflict_test", "Refusing any database except the dedicated fixture database");
  assert.equal(target.search, "", "Refusing URL options that may change the datasource");
  assert.equal(target.hash, "");
  return configured;
}

const error = () => new Error("DIRECT_BOOKING_PROPERTY_NO_LONGER_AVAILABLE");
const issueCode = "DIRECT_BOOKING_PAID_AVAILABILITY_CONFLICT";
const sessionKey = (account: string, id: string) =>
  `${issueCode}:${createHash("sha256").update(JSON.stringify([account, id])).digest("hex")}`;

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function withTransaction(
  db: PrismaClient,
  wrapper: (tx: Prisma.TransactionClient, work: (tx: Prisma.TransactionClient) => Promise<unknown>) => Promise<unknown>
): PrismaClient {
  return new Proxy(db, {
    get(target, field) {
      if (field === "$transaction") {
        return (work: (tx: Prisma.TransactionClient) => Promise<unknown>, options: { isolationLevel?: Prisma.TransactionIsolationLevel } = {}) =>
          db.$transaction(tx => wrapper(tx, work), { ...options, timeout: 10000 });
      }
      const value = Reflect.get(target, field, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function fixture(db: PrismaClient) {
  return async function setup() {
    const suffix = randomUUID().replaceAll("-", "");
    const account = `acct_paidConflictFixture${suffix}`;
    const sessionId = `cs_test_paidConflictFixture${suffix}`;
    const org = await db.organization.create({
      data: { name: "Synthetic paid conflict test", stripeConnectAccountId: account, publicBookingEnabled: true },
    });
    const property = await db.property.create({
      data: { organizationId: org.id, name: "Synthetic paid conflict test", timezone: "America/Puerto_Rico", isPublicBookable: true },
    });
    const eventIds: string[] = [];
    const session = {
      id: sessionId, object: "checkout.session", mode: "payment", payment_status: "paid",
      amount_total: 30000, currency: "usd",
      metadata: {
        flow: "direct_booking", stripeChargeMode: "DIRECT_CHARGE", stripeConnectedAccountId: account,
        propertyId: property.id, organizationId: org.id,
      },
    } as unknown as Stripe.Checkout.Session;
    const makeEvent = (type: "checkout.session.completed" | "checkout.session.async_payment_succeeded"): Stripe.Event => {
      const id = `evt_paidConflictFixture${suffix}${eventIds.length}`;
      eventIds.push(id);
      return { object: "event", id, type, account, livemode: false, data: { object: session } } as unknown as Stripe.Event;
    };
    const key = sessionKey(account, sessionId);
    const outcomeKey = key.slice(issueCode.length + 1);
    async function cleanup() {
      await db.directBookingCheckoutOutcome.deleteMany({ where: { key: outcomeKey } });
      await db.reservation.deleteMany({ where: { propertyId: property.id, externalProvider: "PIN_GO_DIRECT", externalId: sessionId } });
      await db.propertyBlockedDate.deleteMany({ where: { propertyId: property.id } });
      await db.operationalIssue.deleteMany({ where: { organizationId: org.id, propertyId: property.id, issueCode } });
      await db.stripeEventLog.deleteMany({ where: { stripeId: { in: eventIds } } });
      await db.property.delete({ where: { id: property.id } });
      await db.organization.delete({ where: { id: org.id } });
    }
    return {
      account, session, makeEvent, cleanup, org, property,
      key, outcomeKey,
      modelWhere: { where: { operationalKey: sessionKey(account, sessionId) } },
    };
  };
}

function tapDecisionInsert(tx: Prisma.TransactionClient, onInsertAttempt: () => void): Prisma.TransactionClient {
  return new Proxy(tx, {
    get(target, key, receiver) {
      if (key !== "directBookingCheckoutOutcome") return Reflect.get(target, key, receiver);
      const model = tx.directBookingCheckoutOutcome;
      return new Proxy(model, {
        get(inner, method, self) {
          if (method !== "createMany") return Reflect.get(inner, method, self);
          return (args: Parameters<typeof model.createMany>[0]) => {
            onInsertAttempt();
            return model.createMany(args);
          };
        },
      });
    },
  });
}

test("paid direct checkout has exactly one outcome in disposable PostgreSQL", { timeout: 65000 }, async t => {
  const url = testDatabaseUrl();
  const ownerConnection = new PrismaClient({ datasources: { db: { url } } });
  const waiterConnection = new PrismaClient({ datasources: { db: { url } } });
  const observer = new PrismaClient({ datasources: { db: { url } } });
  t.after(async () => { await Promise.all([ownerConnection.$disconnect(), waiterConnection.$disconnect(), observer.$disconnect()]); });

  for (const first of ["BOOKED", "REVIEW"] as const) {
    for (const rollback of [false, true]) {
      await t.test(`${first} stages first; ${rollback ? "roll back then let waiter win" : "commit and exclude waiter"}`, { timeout: 14000 }, async () => {
        const x = await fixture(ownerConnection)();
        const bookingEvent = x.makeEvent("checkout.session.completed");
        const caseEvent = x.makeEvent("checkout.session.async_payment_succeeded");
        const bookingScope = getPaidDirectBookingCheckoutScope(bookingEvent, x.session);
        assert.ok(bookingScope);
        const decisionStaged = signal();
        const secondInsert = signal();
        const commitFirst = signal();
        let ownerPid = 0;
        let waiterPid = 0;
        const backendPid = async (tx: Prisma.TransactionClient) => {
          const [row] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
          assert.ok(row?.pid);
          return row.pid;
        };
        const injected = "FIXTURE_ABORT_FIRST_OUTCOME_AFTER_WRITES";

        async function book(db: PrismaClient) {
          return runIngestTransaction(db, "DIRECT_BOOKING", async tx => {
            // The same service and availability guard called by ingestReservation.
            // Reserve only the minimal row needed to test the unique DB decision.
            await claimPaidDirectBookingIngest(tx, bookingScope!, x.property.id, x.session.id, "PIN_GO_DIRECT");
            const row = {
              propertyId: x.property.id, checkIn: new Date("2027-01-15T20:00:00Z"),
              checkOut: new Date("2027-01-18T15:00:00Z"), source: "DIRECT_BOOKING",
              status: "ACTIVE" as const, paymentState: "PAID" as const,
            };
            await assertDirectBookingIngestAvailability(tx, row, null);
            return tx.reservation.create({
              data: { ...row, guestName: "Synthetic guest", externalProvider: "PIN_GO_DIRECT",
                externalId: x.session.id, stripeCheckoutSessionId: x.session.id },
              select: { id: true },
            });
          });
        }
        const review = (db: PrismaClient) => recordPaidDirectBookingConflict(db, caseEvent, x.session, error());
        const leader = first === "BOOKED" ? book : review;
        const follower = first === "BOOKED" ? review : book;
        const owner = withTransaction(ownerConnection, async (tx, work) => {
          ownerPid = await backendPid(tx);
          const result = await work(tx);
          decisionStaged.resolve();
          await commitFirst.promise;
          if (rollback) throw new Error(injected);
          return result;
        });
        const waiter = withTransaction(waiterConnection, async (tx, work) => {
          waiterPid = await backendPid(tx);
          return work(tapDecisionInsert(tx, secondInsert.resolve));
        });
        let a: Promise<PromiseSettledResult<unknown>> | undefined;
        let b: Promise<PromiseSettledResult<unknown>> | undefined;
        const settle = (task: Promise<unknown>) => task.then(
          value => ({ status: "fulfilled" as const, value }),
          reason => ({ status: "rejected" as const, reason }),
        );
        try {
          for (const e of [bookingEvent, caseEvent]) {
            assert.equal((await claimStripeFinancialEvent(ownerConnection, e)).shouldProcess, true);
          }
          a = settle(leader(owner));
          assert.equal(await Promise.race([decisionStaged.promise.then(() => "staged"), a]), "staged");
          b = settle(follower(waiter));
          assert.equal(await Promise.race([secondInsert.promise.then(() => "contending"), b]), "contending");
          // Prove the second insertion is actually blocked by the first
          // transaction in PostgreSQL, not simply scheduled in JavaScript.
          const deadline = Date.now() + 3000;
          let blockingObserved = false;
          do {
            const [probe] = await observer.$queryRaw<Array<{ blocked: boolean }>>`
              SELECT ${ownerPid}::int = ANY(pg_blocking_pids(${waiterPid}::int)) AS blocked
            `;
            blockingObserved = probe?.blocked === true;
            if (!blockingObserved) await new Promise(done => setTimeout(done, 20));
          } while (!blockingObserved && Date.now() < deadline);
          assert.ok(blockingObserved, "the waiter must reach the actual unique-key lock");
          commitFirst.resolve();
          const [firstResult, secondResult] = await Promise.all([a, b]);
          const winner = rollback ? (first === "BOOKED" ? "REVIEW" : "BOOKED") : first;
          if (rollback) {
            assert.equal(firstResult.status, "rejected");
            if (firstResult.status === "rejected") assert.match(String(firstResult.reason), new RegExp(injected));
            assert.equal(secondResult.status, "fulfilled");
          } else {
            assert.equal(firstResult.status, "fulfilled");
            if (first === "BOOKED") assert.deepEqual(secondResult, { status: "fulfilled", value: false });
            else {
              assert.equal(secondResult.status, "rejected");
              if (secondResult.status === "rejected") assert.equal((secondResult.reason as Error).message, PAID_CHECKOUT_REVIEW_WON);
            }
          }
          const row = await ownerConnection.directBookingCheckoutOutcome.findUniqueOrThrow({ where: { key: x.outcomeKey } });
          assert.equal(row.decision, winner);
          assert.equal(row.bookingEventKey, winner === "BOOKED" ? bookingScope.eventKey : null);
          const reservation = await ownerConnection.reservation.findUnique({ where: { stripeCheckoutSessionId: x.session.id } });
          const issue = await ownerConnection.operationalIssue.findUnique({ ...x.modelWhere, include: { transitions: true } });
          const caseLedger = await ownerConnection.stripeEventLog.findUniqueOrThrow({ where: { stripeId: caseEvent.id } });
          if (winner === "REVIEW") {
            assert.equal(reservation, null);
            assert.ok(issue);
            assert.equal(issue.reservationId, null);
            assert.equal(issue.transitions.length, 1);
            assert.ok(caseLedger.processedAt);
          } else {
            assert.ok(reservation);
            assert.equal(issue, null);
            assert.equal(caseLedger.processedAt, null);
          }
        } finally {
          commitFirst.resolve();
          await Promise.allSettled([a, b]);
          await x.cleanup();
        }
      });
    }
  }
});
