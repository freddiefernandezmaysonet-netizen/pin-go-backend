import assert from "node:assert/strict";
import test from "node:test";
import type { PrismaClient } from "@prisma/client";

import {
  assertReviewInvitationDeliveryFence,
  markReviewInvitationDelivery,
  syncReviewInvitationExpiry,
} from "./review.service.js";

const tokenHashA = "a".repeat(64);
const tokenHashB = "b".repeat(64);
const recipientHash =
  "513935c4d2db2d2d984dff1d68397f6e2ac8c4e5c48c92bd98e02bdc90b7aefe";

function invitationFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: "invitation-1",
    tokenHash: tokenHashA,
    recipientEmailHash: recipientHash,
    status: "INVITED",
    deliveryStatus: "PENDING",
    consumedAt: null,
    expiresAt: new Date("2026-10-01T00:00:00.000Z"),
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    reservation: { guestEmail: "guest@example.com" },
    ...overrides,
  };
}

test("recipient delivery fence rejects a stale token generation before send", async () => {
  const client = {
    propertyReviewInvitation: {
      findUnique: async () =>
        invitationFixture({ tokenHash: tokenHashB }),
    },
  } as unknown as PrismaClient;

  await assert.rejects(
    assertReviewInvitationDeliveryFence(
      {
        invitationId: "invitation-1",
        deliveryFence: {
          tokenHash: tokenHashA,
          recipientEmailHash: recipientHash,
          recipientEmail: "guest@example.com",
        },
        to: "guest@example.com",
        now: new Date("2026-09-01T00:00:00.000Z"),
      },
      client
    ),
    /review invitation changed before delivery/i
  );
});

test("recipient delivery fence accepts only the canonical recipient and generation", async () => {
  const client = {
    propertyReviewInvitation: {
      findUnique: async () => invitationFixture(),
    },
  } as unknown as PrismaClient;

  const result = await assertReviewInvitationDeliveryFence(
    {
      invitationId: "invitation-1",
      deliveryFence: {
        tokenHash: tokenHashA,
        recipientEmailHash: recipientHash,
        recipientEmail: "guest@example.com",
      },
      to: " Guest@Example.com ",
      now: new Date("2026-09-01T00:00:00.000Z"),
    },
    client
  );

  assert.equal(result.recipient, "guest@example.com");
});

test("recipient delivery fence fails closed when the email envelope is stale", async () => {
  const canonicalHash = await import("node:crypto").then(({ createHash }) =>
    createHash("sha256")
      .update("new@example.com")
      .digest("hex")
  );
  const client = {
    propertyReviewInvitation: {
      findUnique: async () =>
        invitationFixture({
          recipientEmailHash: canonicalHash,
          reservation: { guestEmail: "new@example.com" },
        }),
    },
  } as unknown as PrismaClient;

  await assert.rejects(
    assertReviewInvitationDeliveryFence(
      {
        invitationId: "invitation-1",
        deliveryFence: {
          tokenHash: tokenHashA,
          recipientEmailHash: canonicalHash,
          recipientEmail: "new@example.com",
        },
        to: "old@example.com",
        now: new Date("2026-09-01T00:00:00.000Z"),
      },
      client
    ),
    /recipient changed before delivery/i
  );
});

test("a late provider result cannot mark a rotated invitation generation", async () => {
  const updates: Array<Record<string, unknown>> = [];
  const client = {
    propertyReviewInvitation: {
      findUnique: async () =>
        invitationFixture({ tokenHash: tokenHashB }),
      updateMany: async (args: Record<string, unknown>) => {
        updates.push(args);
        return { count: 1 };
      },
    },
  } as unknown as PrismaClient;

  const result = await markReviewInvitationDelivery(
    {
      invitationId: "invitation-1",
      deliveryFence: {
        tokenHash: tokenHashA,
        recipientEmailHash: recipientHash,
        recipientEmail: "guest@example.com",
      },
      delivered: true,
      providerMessageId: "provider-A",
      now: new Date("2026-09-01T00:00:00.000Z"),
    },
    client
  );

  assert.equal(result.count, 0);
  assert.equal(updates.length, 0);
});

test("a provider result cannot mark sent after the canonical recipient drifts", async () => {
  const updates: Array<Record<string, unknown>> = [];
  const client = {
    propertyReviewInvitation: {
      findUnique: async () =>
        invitationFixture({
          reservation: { guestEmail: "new@example.com" },
        }),
      updateMany: async (args: Record<string, unknown>) => {
        updates.push(args);
        return { count: 1 };
      },
    },
  } as unknown as PrismaClient;

  const result = await markReviewInvitationDelivery(
    {
      invitationId: "invitation-1",
      deliveryFence: {
        tokenHash: tokenHashA,
        recipientEmailHash: recipientHash,
        recipientEmail: "guest@example.com",
      },
      delivered: true,
      providerMessageId: "provider-A",
      now: new Date("2026-09-01T00:00:00.000Z"),
    },
    client
  );

  assert.equal(result.count, 0);
  assert.equal(updates.length, 0);
});

test("a late provider failure is CAS-fenced from a rotated generation", async () => {
  const updates: Array<any> = [];
  const client = {
    propertyReviewInvitation: {
      updateMany: async (args: any) => {
        updates.push(args);
        return { count: 0 };
      },
    },
    $transaction: async (operations: Array<Promise<unknown>>) =>
      Promise.all(operations),
  } as unknown as PrismaClient;

  await markReviewInvitationDelivery(
    {
      invitationId: "invitation-1",
      deliveryFence: {
        tokenHash: tokenHashA,
        recipientEmailHash: recipientHash,
        recipientEmail: "guest@example.com",
      },
      delivered: false,
      error: "provider A failed late",
      now: new Date("2026-09-01T00:00:00.000Z"),
    },
    client
  );

  assert.equal(updates.length, 2);
  for (const update of updates) {
    assert.equal(update.where.tokenHash, tokenHashA);
    assert.equal(update.where.recipientEmailHash, recipientHash);
  }
});

test("evidence reconciliation backfills the one provider attempt proven by the message log", async () => {
  const updates: Array<any> = [];
  const acceptedAt = new Date("2026-08-20T12:00:00.000Z");
  const client = {
    propertyReviewInvitation: {
      findUnique: async () => invitationFixture(),
      updateMany: async (args: any) => {
        updates.push(args);
        return { count: 1 };
      },
    },
  } as unknown as PrismaClient;

  const result = await markReviewInvitationDelivery(
    {
      invitationId: "invitation-1",
      deliveryFence: {
        tokenHash: tokenHashA,
        recipientEmailHash: recipientHash,
        recipientEmail: "guest@example.com",
      },
      delivered: true,
      providerMessageId: "provider-A",
      providerAcceptedAt: acceptedAt,
      recordProviderAttempt: false,
      now: new Date("2026-09-01T00:00:00.000Z"),
    },
    client
  );

  assert.equal(result.count, 1);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].data.providerAcceptedAt, acceptedAt);
  assert.equal(updates[0].data.lastDeliveryAttemptAt, acceptedAt);
  assert.deepEqual(
    updates[0].data.deliveryAttemptCount,
    { increment: 1 }
  );
  assert.equal(updates[0].where.tokenHash, tokenHashA);
  assert.equal(
    updates[0].where.recipientEmailHash,
    recipientHash
  );
  assert.equal(
    updates[0].where.reservation.guestEmail,
    "guest@example.com"
  );
});

test("a pre-provider failure stays pending and does not invent a delivery attempt", async () => {
  const updates: Array<any> = [];
  const client = {
    propertyReviewInvitation: {
      updateMany: async (args: any) => {
        updates.push(args);
        return { count: 1 };
      },
    },
    $transaction: async (operations: Array<Promise<unknown>>) =>
      Promise.all(operations),
  } as unknown as PrismaClient;

  await markReviewInvitationDelivery(
    {
      invitationId: "invitation-1",
      deliveryFence: {
        tokenHash: tokenHashA,
        recipientEmailHash: recipientHash,
        recipientEmail: "guest@example.com",
      },
      delivered: false,
      error: "recipient changed before provider",
      recordProviderAttempt: false,
      now: new Date("2026-09-01T00:00:00.000Z"),
    },
    client
  );

  assert.equal(updates[0].data.deliveryStatus, "PENDING");
  assert.equal(updates[0].data.lastDeliveryAttemptAt, undefined);
  assert.equal(updates[0].data.deliveryAttemptCount, undefined);
});

test("evidence reconciliation requires an original provider acceptance timestamp", async () => {
  const client = {
    propertyReviewInvitation: {
      findUnique: async () => invitationFixture(),
    },
  } as unknown as PrismaClient;

  await assert.rejects(
    markReviewInvitationDelivery(
      {
        invitationId: "invitation-1",
        deliveryFence: {
          tokenHash: tokenHashA,
          recipientEmailHash: recipientHash,
          recipientEmail: "guest@example.com",
        },
        delivered: true,
        recordProviderAttempt: false,
      },
      client
    ),
    /original provider acceptance time/i
  );
});

test("checkout extension does not silently reopen an expired bearer generation", async () => {
  const expired = invitationFixture({ status: "EXPIRED" });
  let updates = 0;
  const client = {
    propertyReviewInvitation: {
      findUnique: async () => expired,
      update: async () => {
        updates += 1;
        return expired;
      },
    },
  } as any;

  const result = await syncReviewInvitationExpiry(
    {
      reservationId: "reservation-1",
      checkOut: new Date("2026-10-15T00:00:00.000Z"),
      now: new Date("2026-09-01T00:00:00.000Z"),
    },
    client
  );

  assert.equal(result, expired);
  assert.equal(updates, 0);
});
