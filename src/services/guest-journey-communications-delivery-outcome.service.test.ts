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
        }),
        update: async (args: any) => {
          updates.push(args);
          return { id: "message-1" };
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
