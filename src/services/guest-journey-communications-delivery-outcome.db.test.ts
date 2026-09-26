import assert from "node:assert/strict";
import test from "node:test";
import { PrismaClient } from "@prisma/client";

import {
  recordMessageDeliveryOutcome,
} from "./guest-journey-communications-delivery-outcome.service";

const prisma = new PrismaClient();

test("provider delivery outcome persists separately from send-attempt status", async (t) => {
  const providerMessageId =
    "delivery-db-canary-" +
    Date.now().toString(36);

  const message = await prisma.messageLog.create({
    data: {
      channel: "email",
      to: "delivery-canary@example.invalid",
      body: JSON.stringify({
        kind: "MESSAGE_DELIVERY_OUTCOME_DB_CERTIFICATION",
      }),
      provider: "resend",
      providerMessageId,
      status: "SENT",
      communicationType: "PRECHECKIN",
    },
  });

  t.after(async () => {
    await prisma.messageLog.delete({
      where: { id: message.id },
    }).catch(() => {});
    await prisma.$disconnect();
  });

  const eventAt =
    new Date("2026-09-26T19:15:00.000Z");

  const result =
    await recordMessageDeliveryOutcome(
      prisma,
      {
        provider: "resend",
        providerMessageId,
        status: "DELIVERED",
        eventAt,
        deliveredAt: eventAt,
      }
    );

  assert.deepEqual(result, {
    matched: true,
    applied: true,
    messageLogId: message.id,
  });

  const persisted =
    await prisma.messageLog.findUniqueOrThrow({
      where: { id: message.id },
      select: {
        status: true,
        providerDeliveryStatus: true,
        providerStatusUpdatedAt: true,
        deliveredAt: true,
        providerErrorCode: true,
        providerErrorMessage: true,
      },
    });

  assert.equal(
    persisted.status,
    "SENT",
    "provider callbacks must not overwrite send-attempt status"
  );
  assert.equal(
    persisted.providerDeliveryStatus,
    "DELIVERED"
  );
  assert.equal(
    persisted.providerStatusUpdatedAt?.toISOString(),
    eventAt.toISOString()
  );
  assert.equal(
    persisted.deliveredAt?.toISOString(),
    eventAt.toISOString()
  );
  assert.equal(persisted.providerErrorCode, null);
  assert.equal(persisted.providerErrorMessage, null);
});
