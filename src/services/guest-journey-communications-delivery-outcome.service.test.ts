import assert from "node:assert/strict";
import test from "node:test";
import { createHmac } from "node:crypto";

import {
  normalizeResendDeliveryEvent,
  normalizeTwilioDeliveryCallback,
  recordMessageDeliveryOutcome,
  shouldApplyProviderDeliveryTransition,
  verifyResendWebhookSignature,
} from "./guest-journey-communications-delivery-outcome.service";

test("Resend delivery events normalize to provider outcomes", () => {
  const delivered = normalizeResendDeliveryEvent({
    type: "email.delivered",
    created_at: "2026-09-26T18:00:00.000Z",
    data: {
      email_id: "re_email_1",
    },
  });

  assert.equal(delivered?.provider, "resend");
  assert.equal(delivered?.providerMessageId, "re_email_1");
  assert.equal(delivered?.status, "DELIVERED");
  assert.equal(
    delivered?.deliveredAt?.toISOString(),
    "2026-09-26T18:00:00.000Z"
  );

  const bounced = normalizeResendDeliveryEvent({
    type: "email.bounced",
    created_at: "2026-09-26T18:01:00.000Z",
    data: {
      email_id: "re_email_2",
      bounce: {
        type: "Permanent",
        message: "Mailbox unavailable",
      },
    },
  });

  assert.equal(bounced?.status, "BOUNCED");
  assert.equal(bounced?.errorCode, "Permanent");
  assert.equal(bounced?.errorMessage, "Mailbox unavailable");
});

test("Twilio callbacks normalize delivery and error evidence", () => {
  const delivered = normalizeTwilioDeliveryCallback(
    {
      MessageSid: "SM123",
      MessageStatus: "delivered",
    },
    new Date("2026-09-26T18:02:00.000Z")
  );

  assert.equal(delivered?.provider, "twilio");
  assert.equal(delivered?.status, "DELIVERED");
  assert.equal(delivered?.providerMessageId, "SM123");

  const undelivered = normalizeTwilioDeliveryCallback(
    {
      MessageSid: "SM124",
      MessageStatus: "undelivered",
      ErrorCode: "30004",
      ErrorMessage: "Message blocked",
    },
    new Date("2026-09-26T18:03:00.000Z")
  );

  assert.equal(undelivered?.status, "UNDELIVERED");
  assert.equal(undelivered?.errorCode, "30004");
  assert.equal(undelivered?.errorMessage, "Message blocked");
});

test("delivery transitions do not downgrade terminal evidence", () => {
  assert.equal(
    shouldApplyProviderDeliveryTransition("DELIVERED", "SENT"),
    false
  );
  assert.equal(
    shouldApplyProviderDeliveryTransition("DELIVERED", "COMPLAINED"),
    true
  );
  assert.equal(
    shouldApplyProviderDeliveryTransition("COMPLAINED", "DELIVERED"),
    false
  );
  assert.equal(
    shouldApplyProviderDeliveryTransition("SENT", "DELIVERED"),
    true
  );
  assert.equal(
    shouldApplyProviderDeliveryTransition("DELIVERY_DELAYED", "DELIVERED"),
    true
  );
});

function fakePrisma(input: {
  providerDeliveryStatus?: string | null;
  deliveredAt?: Date | null;
  providerStatusUpdatedAt?: Date | null;
}) {
  const updates: any[] = [];

  return {
    updates,
    prisma: {
      messageLog: {
        findFirst: async () => ({
          id: "message-1",
          providerDeliveryStatus:
            input.providerDeliveryStatus ?? null,
          deliveredAt: input.deliveredAt ?? null,
          providerStatusUpdatedAt: input.providerStatusUpdatedAt ?? null,
        }),
        update: async (args: any) => {
          updates.push(args);
          return { id: "message-1" };
        },
        updateMany: async (args: any) => {
          updates.push(args);
          return { count: 1 };
        },
      },
    } as any,
  };
}

test("recording delivery outcome preserves send-attempt status semantics", async () => {
  const fixture = fakePrisma({
    providerDeliveryStatus: "SENT",
  });

  const result = await recordMessageDeliveryOutcome(
    fixture.prisma,
    {
      provider: "resend",
      providerMessageId: "email-1",
      status: "DELIVERED",
      eventAt: new Date("2026-09-26T18:04:00.000Z"),
      deliveredAt: new Date("2026-09-26T18:04:00.000Z"),
    }
  );

  assert.deepEqual(result, {
    matched: true,
    applied: true,
    messageLogId: "message-1",
  });
  assert.equal(fixture.updates.length, 1);
  assert.equal(
    fixture.updates[0].data.providerDeliveryStatus,
    "DELIVERED"
  );
  assert.equal(
    fixture.updates[0].data.deliveredAt.toISOString(),
    "2026-09-26T18:04:00.000Z"
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(
      fixture.updates[0].data,
      "status"
    ),
    false,
    "provider delivery callbacks must not mutate MessageLog.status"
  );
});

test("out-of-order provider events are ignored", async () => {
  const fixture = fakePrisma({
    providerDeliveryStatus: "DELIVERED",
    deliveredAt: new Date("2026-09-26T18:04:00.000Z"),
  });

  const result = await recordMessageDeliveryOutcome(
    fixture.prisma,
    {
      provider: "twilio",
      providerMessageId: "SM123",
      status: "SENT",
      eventAt: new Date("2026-09-26T18:05:00.000Z"),
    }
  );

  assert.equal(result.matched, true);
  assert.equal(result.applied, false);
  assert.equal(fixture.updates.length, 0);
});


test("Resend Svix signature verifier accepts valid payload and rejects tampering", () => {
  const key = Buffer.from(
    "pin-go-resend-webhook-canary-secret",
    "utf8"
  );
  const secret =
    "whsec_" + key.toString("base64");
  const id = "msg_test_1";
  const timestamp = "1780000000";
  const payload =
    '{"type":"email.delivered","data":{"email_id":"email-1"}}';

  const signature = createHmac("sha256", key)
    .update(`${id}.${timestamp}.${payload}`, "utf8")
    .digest("base64");

  const input = {
    payload,
    secret,
    id,
    timestamp,
    signature: `v1,${signature}`,
    now: new Date(1780000000 * 1000),
  };

  assert.equal(
    verifyResendWebhookSignature(input),
    true
  );

  assert.equal(
    verifyResendWebhookSignature({
      ...input,
      payload: payload + " ",
    }),
    false
  );

  assert.equal(
    verifyResendWebhookSignature({
      ...input,
      signature:
        `v1,invalid v1,${signature}`,
    }),
    true,
    "multiple signatures must accept any valid v1 candidate"
  );

  assert.equal(
    verifyResendWebhookSignature({
      ...input,
      now: new Date(
        (1780000000 + 301) * 1000
      ),
    }),
    false,
    "stale signatures must be rejected"
  );
});


const receiptTime = new Date("2026-11-22T16:00:02Z");
const oldReceiptTime = new Date("2026-11-22T16:00:01Z");
const deliveredReceipt = {
  provider: "twilio" as const, providerMessageId: "SM_test",
  status: "DELIVERED" as const, eventAt: receiptTime, deliveredAt: receiptTime,
};

function concurrentReceiptFixture() {
  let row: any = { id: "message-1", provider: "twilio", providerMessageId: "SM_test",
    providerDeliveryStatus: "SENT", providerStatusUpdatedAt: oldReceiptTime, deliveredAt: null };
  const writes: any[] = [];
  const same = (a: any, b: any) => a instanceof Date && b instanceof Date ? +a === +b : a === b;
  const prisma = { messageLog: {
    findFirst: async () => ({ ...row }),
    update: async ({data}: any) => { row = { ...row, ...data }; writes.push(data); return row; },
    updateMany: async ({ where, data }: any) => {
      if (!Object.entries(where).every(([key, value]) => same(row[key], value))) return { count: 0 };
      row = { ...row, ...data }; writes.push(data); return { count: 1 };
    },
  } } as any;
  return { prisma, writes, read: () => ({ ...row }) };
}

test("older duplicate delivery preserves the recovery timestamp invariant", async () => {
  const f = concurrentReceiptFixture();
  await recordMessageDeliveryOutcome(f.prisma, deliveredReceipt);
  const confirmed = f.read();
  const result = await recordMessageDeliveryOutcome(f.prisma, {
    ...deliveredReceipt, eventAt: oldReceiptTime, deliveredAt: oldReceiptTime,
  });
  assert.equal(result.applied, false);
  assert.deepEqual(f.read(), confirmed);
  assert.ok(f.read().providerStatusUpdatedAt >= f.read().deliveredAt);
  assert.equal(f.writes.length, 1);
});

test("identical callbacks are idempotent and later callbacks retain original delivery time", async () => {
  const f = concurrentReceiptFixture();
  await recordMessageDeliveryOutcome(f.prisma, deliveredReceipt);
  assert.equal((await recordMessageDeliveryOutcome(f.prisma, deliveredReceipt)).applied, false);
  const later = new Date(+receiptTime + 1000);
  assert.equal((await recordMessageDeliveryOutcome(f.prisma, {
    ...deliveredReceipt, eventAt: later, deliveredAt: later,
  })).applied, true);
  assert.deepEqual(f.read().deliveredAt, receiptTime);
  assert.deepEqual(f.read().providerStatusUpdatedAt, later);
});

test("stronger late terminal evidence is retained without moving timestamps backwards", async () => {
  const f = concurrentReceiptFixture();
  await recordMessageDeliveryOutcome(f.prisma, deliveredReceipt);
  await recordMessageDeliveryOutcome(f.prisma, {
    ...deliveredReceipt, status: "COMPLAINED", eventAt: oldReceiptTime,
    deliveredAt: null, errorMessage: "Synthetic complaint",
  });
  assert.equal(f.read().providerDeliveryStatus, "COMPLAINED");
  assert.deepEqual(f.read().providerStatusUpdatedAt, receiptTime);
  assert.deepEqual(f.read().deliveredAt, receiptTime);
});

test("concurrent callbacks cannot overwrite a terminal result from a stale snapshot", async () => {
  for (const reverse of [false, true]) {
    const f = concurrentReceiptFixture();
    const delayed = { ...deliveredReceipt, status: "DELIVERY_DELAYED" as const,
      eventAt: new Date(+receiptTime + 1000), deliveredAt: null };
    const outcomes = reverse ? [delayed, deliveredReceipt] : [deliveredReceipt, delayed];
    await Promise.all(outcomes.map(outcome => recordMessageDeliveryOutcome(f.prisma, outcome)));
    assert.equal(f.read().providerDeliveryStatus, "DELIVERED");
    assert.ok(f.read().providerStatusUpdatedAt >= f.read().deliveredAt);
  }
});

test("repeated conflicts throw instead of reporting an unapplied receipt as successful", async () => {
  const f = concurrentReceiptFixture();
  let conflicts = 0;
  f.prisma.messageLog.updateMany = async () => { conflicts++; return { count: 0 }; };
  await assert.rejects(recordMessageDeliveryOutcome(f.prisma, deliveredReceipt), /RECEIPT_CONFLICT/);
  assert.equal(conflicts, 3);
  assert.equal(f.read().providerDeliveryStatus, "SENT");
});

test("invalid event dates fail before any persistence", async () => {
  const f = concurrentReceiptFixture();
  for (const invalid of [{ eventAt: new Date(NaN) }, { deliveredAt: new Date(NaN) }]) {
    await assert.rejects(recordMessageDeliveryOutcome(f.prisma, { ...deliveredReceipt, ...invalid }), /EVENT_TIME_INVALID/);
  }
  assert.equal(f.writes.length, 0);
});

test("an uncorrelated receipt still reports unmatched, not successful delivery", async () => {
  const f = concurrentReceiptFixture();
  f.prisma.messageLog.findFirst = async () => null;
  assert.deepEqual(await recordMessageDeliveryOutcome(f.prisma, deliveredReceipt), {
    matched: false, applied: false, messageLogId: null,
  });
  assert.equal(f.writes.length, 0);
});
