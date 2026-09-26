import assert from "node:assert/strict";
import test from "node:test";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const MAX_RETRIES = 3;

function retryBody(type: string) {
  return JSON.stringify({
    kind: "PIN_GO_EMAIL_DELIVERY",
    type,
    subject: "Provider delivery retry certification",
    retryPayload: {},
  });
}

test("Postgres retry selector preserves legacy FAILED and adds only provider FAILED", async (t) => {
  const prefix =
    "provider-retry-db-" +
    Date.now().toString(36);

  const rows = await Promise.all([
    prisma.messageLog.create({
      data: {
        channel: "email",
        to: `${prefix}-legacy@example.invalid`,
        body: retryBody("GUEST_ACCESS_PASSCODE"),
        provider: "resend",
        providerMessageId: `${prefix}-legacy`,
        status: "FAILED",
        retryCount: 0,
        communicationType: "GUEST_ACCESS_PASSCODE",
      },
    }),
    prisma.messageLog.create({
      data: {
        channel: "email",
        to: `${prefix}-provider-failed@example.invalid`,
        body: retryBody("GUEST_ACCESS_PASSCODE"),
        provider: "resend",
        providerMessageId: `${prefix}-provider-failed`,
        status: "SENT",
        providerDeliveryStatus: "FAILED",
        retryCount: 0,
        communicationType: "GUEST_ACCESS_PASSCODE",
      },
    }),
    prisma.messageLog.create({
      data: {
        channel: "email",
        to: `${prefix}-bounced@example.invalid`,
        body: retryBody("GUEST_ACCESS_PASSCODE"),
        provider: "resend",
        providerMessageId: `${prefix}-bounced`,
        status: "SENT",
        providerDeliveryStatus: "BOUNCED",
        retryCount: 0,
        communicationType: "GUEST_ACCESS_PASSCODE",
      },
    }),
    prisma.messageLog.create({
      data: {
        channel: "email",
        to: `${prefix}-suppressed@example.invalid`,
        body: retryBody("GUEST_ACCESS_PASSCODE"),
        provider: "resend",
        providerMessageId: `${prefix}-suppressed`,
        status: "SENT",
        providerDeliveryStatus: "SUPPRESSED",
        retryCount: 0,
        communicationType: "GUEST_ACCESS_PASSCODE",
      },
    }),
    prisma.messageLog.create({
      data: {
        channel: "email",
        to: `${prefix}-complained@example.invalid`,
        body: retryBody("GUEST_ACCESS_PASSCODE"),
        provider: "resend",
        providerMessageId: `${prefix}-complained`,
        status: "SENT",
        providerDeliveryStatus: "COMPLAINED",
        retryCount: 0,
        communicationType: "GUEST_ACCESS_PASSCODE",
      },
    }),
    prisma.messageLog.create({
      data: {
        channel: "email",
        to: `${prefix}-delivered@example.invalid`,
        body: retryBody("GUEST_ACCESS_PASSCODE"),
        provider: "resend",
        providerMessageId: `${prefix}-delivered`,
        status: "SENT",
        providerDeliveryStatus: "DELIVERED",
        retryCount: 0,
        communicationType: "GUEST_ACCESS_PASSCODE",
      },
    }),
    prisma.messageLog.create({
      data: {
        channel: "email",
        to: `${prefix}-exhausted@example.invalid`,
        body: retryBody("GUEST_ACCESS_PASSCODE"),
        provider: "resend",
        providerMessageId: `${prefix}-exhausted`,
        status: "FAILED",
        retryCount: MAX_RETRIES,
        communicationType: "GUEST_ACCESS_PASSCODE",
      },
    }),
  ]);

  t.after(async () => {
    await prisma.messageLog.deleteMany({
      where: {
        id: { in: rows.map((row) => row.id) },
      },
    }).catch(() => {});
    await prisma.$disconnect();
  });

  const selected = await prisma.messageLog.findMany({
    where: {
      id: { in: rows.map((row) => row.id) },
      channel: "email",
      provider: "resend",
      OR: [
        { status: "FAILED" },
        {
          status: "SENT",
          providerDeliveryStatus: "FAILED",
        },
      ],
      retryCount: { lt: MAX_RETRIES },
      body: {
        contains: '"type":"GUEST_ACCESS_PASSCODE"',
      },
    },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      status: true,
      providerDeliveryStatus: true,
      retryCount: true,
    },
  });

  assert.deepEqual(
    selected.map((row) => ({
      status: row.status,
      providerDeliveryStatus:
        row.providerDeliveryStatus,
      retryCount: row.retryCount,
    })),
    [
      {
        status: "FAILED",
        providerDeliveryStatus: null,
        retryCount: 0,
      },
      {
        status: "SENT",
        providerDeliveryStatus: "FAILED",
        retryCount: 0,
      },
    ]
  );
});

test("successful provider-failure retry resets prior provider outcome for the new providerMessageId", async (t) => {
  const providerMessageId =
    "provider-retry-reset-" +
    Date.now().toString(36);

  const message = await prisma.messageLog.create({
    data: {
      channel: "email",
      to: "provider-retry-reset@example.invalid",
      body: retryBody("GUEST_ACCESS_PASSCODE"),
      provider: "resend",
      providerMessageId,
      status: "SENT",
      providerDeliveryStatus: "FAILED",
      providerStatusUpdatedAt:
        new Date("2026-09-26T20:00:00.000Z"),
      providerErrorCode: "provider_failed",
      providerErrorMessage:
        "Provider failed after accepting the message",
      retryCount: 0,
      communicationType: "GUEST_ACCESS_PASSCODE",
    },
  });

  t.after(async () => {
    await prisma.messageLog.delete({
      where: { id: message.id },
    }).catch(() => {});
    await prisma.$disconnect();
  });

  const replacementProviderMessageId =
    `${providerMessageId}-retry-1`;

  await prisma.messageLog.update({
    where: { id: message.id },
    data: {
      status: "SENT",
      providerMessageId:
        replacementProviderMessageId,
      providerDeliveryStatus: null,
      providerStatusUpdatedAt: null,
      providerErrorCode: null,
      providerErrorMessage: null,
      deliveredAt: null,
      retryCount: { increment: 1 },
      error: null,
    },
  });

  const persisted =
    await prisma.messageLog.findUniqueOrThrow({
      where: { id: message.id },
      select: {
        status: true,
        providerMessageId: true,
        providerDeliveryStatus: true,
        providerStatusUpdatedAt: true,
        providerErrorCode: true,
        providerErrorMessage: true,
        deliveredAt: true,
        retryCount: true,
      },
    });

  assert.deepEqual(persisted, {
    status: "SENT",
    providerMessageId:
      replacementProviderMessageId,
    providerDeliveryStatus: null,
    providerStatusUpdatedAt: null,
    providerErrorCode: null,
    providerErrorMessage: null,
    deliveredAt: null,
    retryCount: 1,
  });
});
