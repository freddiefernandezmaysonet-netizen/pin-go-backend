import assert from "node:assert/strict";
import test from "node:test";

import { ReservationStatus, type PrismaClient } from "@prisma/client";

import { executeGuestJourneyCommunicationDeliveryAdapter } from "./guest-journey-communications-delivery-adapter.service";
import type { ClaimedCommunicationIntent } from "./guest-journey-communications-owner-runtime.service";

const now = new Date("2026-08-23T04:30:00.000Z");

function claim(payload: Record<string, unknown>): ClaimedCommunicationIntent {
  return {
    intentId: "intent-1",
    intentKey: "intent-key-1",
    reservationId: "reservation-1",
    journeyId: "journey-1",
    organizationId: "org-1",
    propertyId: "property-1",
    targetEngine: "COMMUNICATIONS",
    intentType: "REQUEST_COMMUNICATION_RETRY",
    expectedOutcomeCode: "COMMUNICATION_DELIVERY_FINAL",
    payload,
    inputEvidenceFingerprint: "input-fingerprint",
    attemptNumber: 1,
    leaseToken: "lease-token",
    leaseExpiresAt: new Date(now.getTime() + 60_000),
  };
}

function fakePrisma(input: {
  message?: Record<string, any>;
  reservation?: Record<string, any> | null;
  reservationSequence?: Array<Record<string, any> | null>;
}) {
  const message = {
    id: "message-1",
    reservationId: "reservation-1",
    propertyId: "property-1",
    organizationId: "org-1",
    communicationType: "PRECHECKIN",
    channel: "sms",
    status: "FAILED",
    retryCount: 0,
    to: "+17875550101",
    body: "Existing canonical body",
    providerMessageId: null,
    error: "provider failed",
    ...input.message,
  };
  const reservation = input.reservation === null ? null : {
    status: ReservationStatus.ACTIVE,
    guestEmail: "guest@example.com",
    guestPhone: "+17875550101",
    checkIn: new Date("2026-08-24T20:00:00.000Z"),
    checkOut: new Date("2026-08-27T15:00:00.000Z"),
    cancelledAt: null,
    ...input.reservation,
  };
  const updates: Array<any> = [];
  let reservationReads = 0;
  const prisma = {
    reservation: {
      findFirst: async () => {
        if (!input.reservationSequence) return reservation;
        const value = input.reservationSequence[
          Math.min(reservationReads, input.reservationSequence.length - 1)
        ];
        reservationReads += 1;
        return value;
      },
    },
    messageLog: {
      findFirst: async () => message,
      updateMany: async (args: any) => {
        updates.push(args);
        if (args.where.status !== undefined && args.where.status !== message.status) {
          return { count: 0 };
        }
        if (args.data.status) message.status = args.data.status;
        if (args.data.providerMessageId !== undefined) {
          message.providerMessageId = args.data.providerMessageId;
        }
        if (args.data.error !== undefined) message.error = args.data.error;
        if (args.data.retryCount?.increment) message.retryCount += args.data.retryCount.increment;
        return { count: 1 };
      },
    },
  };
  return { prisma: prisma as unknown as PrismaClient, message, updates };
}

const noEmail = async () => {
  throw new Error("email must not execute");
};

test("missing correlation evidence waits without contacting a provider", async () => {
  const { prisma } = fakePrisma({});
  let calls = 0;
  const result = await executeGuestJourneyCommunicationDeliveryAdapter(
    prisma,
    claim({ communicationType: "PRECHECKIN", channel: "sms" }),
    { now },
    {
      sendSms: async () => { calls += 1; return { sid: "unexpected" } as any; },
      sendEmail: noEmail,
    }
  );
  assert.equal(calls, 0);
  assert.equal(result.providerCalls, 0);
  assert.equal(result.completion.kind, "WAITING_FOR_EVIDENCE");
});

test("a previously SENT correlated message deduplicates without provider replay", async () => {
  const { prisma } = fakePrisma({ message: { status: "SENT", providerMessageId: "SM-old" } });
  let calls = 0;
  const result = await executeGuestJourneyCommunicationDeliveryAdapter(
    prisma,
    claim({ messageLogId: "message-1", communicationType: "PRECHECKIN", channel: "sms" }),
    { now },
    {
      sendSms: async () => { calls += 1; return { sid: "unexpected" } as any; },
      sendEmail: noEmail,
    }
  );
  assert.equal(calls, 0);
  assert.equal(result.completion.kind, "SUCCEEDED");
});

test("a retry fences the message, preserves recipient/body, and persists provider evidence", async () => {
  const { prisma, message, updates } = fakePrisma({});
  const calls: Array<[string, string]> = [];
  const result = await executeGuestJourneyCommunicationDeliveryAdapter(
    prisma,
    claim({ messageLogId: "message-1", communicationType: "PRECHECKIN", channel: "sms" }),
    { now, providerTimeoutMs: 100 },
    {
      sendSms: async (to, body) => {
        calls.push([to, body]);
        return { sid: "SM-new" } as any;
      },
      sendEmail: noEmail,
    }
  );
  assert.deepEqual(calls, [["+17875550101", "Existing canonical body"]]);
  assert.equal(updates[0].data.status, "E7_SENDING");
  assert.equal(message.status, "SENT");
  assert.equal(message.providerMessageId, "SM-new");
  assert.equal(message.retryCount, 1);
  assert.equal(result.providerCalls, 1);
  assert.equal(result.completion.kind, "SUCCEEDED");
});

test("provider timeout leaves an ambiguity fence and blocks automatic duplicate replay", async () => {
  const fixture = fakePrisma({});
  let calls = 0;
  const dependencies = {
    sendSms: async () => {
      calls += 1;
      return new Promise<any>(() => {});
    },
    sendEmail: noEmail,
  };
  const first = await executeGuestJourneyCommunicationDeliveryAdapter(
    fixture.prisma,
    claim({ messageLogId: "message-1", communicationType: "PRECHECKIN", channel: "sms" }),
    { now, providerTimeoutMs: 5 },
    dependencies
  );
  assert.equal(first.completion.kind, "WAITING_FOR_EVIDENCE");
  assert.equal(fixture.message.status, "E7_SENDING");

  const second = await executeGuestJourneyCommunicationDeliveryAdapter(
    fixture.prisma,
    claim({ messageLogId: "message-1", communicationType: "PRECHECKIN", channel: "sms" }),
    { now, providerTimeoutMs: 5 },
    dependencies
  );
  assert.equal(second.providerCalls, 0);
  assert.equal(calls, 1);
});

test("cancellation and date changes invalidate obsolete messages without sending", async () => {
  const cancelled = fakePrisma({
    reservation: { status: ReservationStatus.CANCELLED, cancelledAt: now },
  });
  let calls = 0;
  const result = await executeGuestJourneyCommunicationDeliveryAdapter(
    cancelled.prisma,
    claim({ messageLogId: "message-1", communicationType: "PRECHECKIN", channel: "sms" }),
    { now },
    {
      sendSms: async () => { calls += 1; return { sid: "unexpected" } as any; },
      sendEmail: noEmail,
    }
  );
  assert.equal(calls, 0);
  assert.equal(cancelled.message.status, "OBSOLETE");
  assert.equal(result.completion.kind, "SUCCEEDED");
  if (result.completion.kind === "SUCCEEDED") {
    assert.equal(result.completion.deliveryStatus, "OBSOLETE");
  }
});

test("recipient drift fails closed before the provider boundary", async () => {
  const { prisma } = fakePrisma({ reservation: { guestPhone: "+17875550999" } });
  let calls = 0;
  await assert.rejects(
    executeGuestJourneyCommunicationDeliveryAdapter(
      prisma,
      claim({ messageLogId: "message-1", communicationType: "PRECHECKIN", channel: "sms" }),
      { now },
      {
        sendSms: async () => { calls += 1; return { sid: "unexpected" } as any; },
        sendEmail: noEmail,
      }
    ),
    /RECIPIENT_CHANGED_OR_INVALID/
  );
  assert.equal(calls, 0);
});

test("legacy final failures escalate through E7 without an automatic provider replay", async () => {
  const { prisma } = fakePrisma({ message: { status: "FAILED_FINAL" } });
  let calls = 0;
  const result = await executeGuestJourneyCommunicationDeliveryAdapter(
    prisma,
    claim({ messageLogId: "message-1", communicationType: "PRECHECKIN", channel: "sms" }),
    { now },
    {
      sendSms: async () => { calls += 1; return { sid: "unexpected" } as any; },
      sendEmail: noEmail,
    }
  );
  assert.equal(calls, 0);
  assert.equal(result.completion.kind, "RETRYABLE");
  if (result.completion.kind === "RETRYABLE") {
    assert.equal(result.completion.errorCode, "COMMUNICATION_LEGACY_FINAL_FAILURE");
  }
});

test("redacted generic SMS evidence is never sent as guest content", async () => {
  const { prisma } = fakePrisma({ message: { body: "secure link /guest/verify/abcd****" } });
  let calls = 0;
  await assert.rejects(
    executeGuestJourneyCommunicationDeliveryAdapter(
      prisma,
      claim({ messageLogId: "message-1", communicationType: "PRECHECKIN", channel: "sms" }),
      { now },
      {
        sendSms: async () => { calls += 1; return { sid: "unexpected" } as any; },
        sendEmail: noEmail,
      }
    ),
    /SMS_BODY_NOT_REPLAYABLE/
  );
  assert.equal(calls, 0);
});

test("the tenant, dates and recipient are re-fenced immediately before provider execution", async () => {
  const baseReservation = {
    status: ReservationStatus.ACTIVE,
    guestEmail: "guest@example.com",
    guestPhone: "+17875550101",
    checkIn: new Date("2026-08-24T20:00:00.000Z"),
    checkOut: new Date("2026-08-27T15:00:00.000Z"),
    cancelledAt: null,
  };
  const fixture = fakePrisma({
    reservationSequence: [
      baseReservation,
      { ...baseReservation, guestPhone: "+17875550999" },
    ],
  });
  let calls = 0;
  const result = await executeGuestJourneyCommunicationDeliveryAdapter(
    fixture.prisma,
    claim({ messageLogId: "message-1", communicationType: "PRECHECKIN", channel: "sms" }),
    { now },
    {
      sendSms: async () => { calls += 1; return { sid: "unexpected" } as any; },
      sendEmail: noEmail,
    }
  );
  assert.equal(calls, 0);
  assert.equal(fixture.message.status, "OBSOLETE");
  assert.equal(result.completion.kind, "SUCCEEDED");
});
