import assert from "node:assert/strict";
import test from "node:test";

import type { PinAIRuntimeRequest } from "./contracts.js";
import { createConversationMemory } from "./conversation-memory.js";
import { PinGoRuntimeReadToolExecutor } from "./pin-go-read-tool-executor.js";

const request: PinAIRuntimeRequest = {
  context: {
    organizationId: "org-a",
    propertyId: "property-a",
    reservationId: "reservation-a",
    guestId: "guest-a",
    currentLocalDateTime: "2026-09-20T12:00:00-04:00",
    preferredLanguage: "en",
  },
  conversation: [{ role: "guest", content: "What is my access status?" }],
};

function createPrismaFixture() {
  return {
    property: {
      async findFirst() {
        return {
          id: "property-a",
          organizationId: "org-a",
          name: "Casa Test",
          publicTitle: "Casa Test",
          publicDescription: "Test property",
          publicDescriptionEs: "Propiedad de prueba",
          maxGuests: 4,
          timezone: "America/Puerto_Rico",
          checkInTime: "16:00",
          checkOutTime: "11:00",
          guestAccessMode: "PASSCODE_ONLY",
          amenities: [],
          locks: [],
          propertyDevices: [],
          guestAgreements: [],
          cancellationPolicies: [],
        };
      },
    },
    reservation: {
      async findFirst(args: any) {
        if (args?.select?.id === true && Object.keys(args.select).length === 1) {
          return { id: "reservation-a" };
        }
        return {
          id: "reservation-a",
          reservationNumber: "#PG-2026-000001",
          propertyId: "property-a",
          preferredLanguage: "en",
          checkIn: new Date("2026-09-20T20:00:00.000Z"),
          checkOut: new Date("2026-09-22T15:00:00.000Z"),
          adults: 2,
          children: 0,
          status: "ACTIVE",
          source: "DIRECT_BOOKING",
          paymentState: "PAID",
          verificationStatus: "VERIFIED",
          identityVerificationRequiredSnapshot: true,
          stripeIdentityVerificationStatus: "VERIFIED",
          guestAgreementSignedAt: new Date("2026-09-19T20:00:00.000Z"),
          guestAccessReleaseStatus: "RELEASED",
          guestAccessEligibleAt: new Date("2026-09-20T18:00:00.000Z"),
          guestAccessReleasedAt: new Date("2026-09-20T18:01:00.000Z"),
          guestAccessModeSnapshot: "PASSCODE_ONLY",
          cancellationPolicySnapshot: { version: "v1" },
          cancelledAt: null,
          property: {
            organizationId: "org-a",
            timezone: "America/Puerto_Rico",
            checkInTime: "16:00",
            checkOutTime: "11:00",
            maxGuests: 4,
          },
        };
      },
    },
    accessGrant: {
      async findMany() {
        return [
          {
            method: "PASSCODE",
            status: "ACTIVE",
            startsAt: new Date("2026-09-20T18:00:00.000Z"),
            endsAt: new Date("2026-09-22T15:00:00.000Z"),
            type: "GUEST",
            lastError: null,
            recoveryOperation: null,
            recoveryAttemptCount: 0,
            recoveryExhaustedAt: null,
            lastAppliedAt: new Date("2026-09-20T18:01:00.000Z"),
            revokedReason: null,
            lock: {
              displayName: "Front Door",
              locationLabel: "Main entrance",
              isActive: true,
            },
          },
        ];
      },
    },
    cleaningConfirmation: {
      async findFirst() {
        return {
          status: "CONFIRMED",
          createdAt: new Date("2026-09-20T12:00:00.000Z"),
          updatedAt: new Date("2026-09-20T13:00:00.000Z"),
        };
      },
      async findMany() {
        return [
          {
            status: "CONFIRMED",
            createdAt: new Date("2026-09-20T12:00:00.000Z"),
            updatedAt: new Date("2026-09-20T13:00:00.000Z"),
          },
        ];
      },
    },
    propertyBlockedDate: {
      async findFirst() {
        return null;
      },
    },
    reservationModification: {
      async findFirst() {
        return null;
      },
    },
  };
}

test("real read adapter returns scoped reservation context without guest PII or Stripe IDs", async () => {
  const executor = new PinGoRuntimeReadToolExecutor(createPrismaFixture());
  const result = await executor.execute(
    "get_reservation_context",
    {},
    request,
    createConversationMemory(request),
  );

  const serialized = JSON.stringify(result);
  assert.match(serialized, /#PG-2026-000001/);
  assert.doesNotMatch(serialized, /guestEmail|guestPhone|guestToken|stripePaymentIntentId/);
});

test("real read adapter exposes access state without credentials or TTLock identifiers", async () => {
  const executor = new PinGoRuntimeReadToolExecutor(createPrismaFixture());
  const result = await executor.execute(
    "get_access_status",
    {},
    request,
    createConversationMemory(request),
  );

  const serialized = JSON.stringify(result);
  assert.match(serialized, /ACTIVE/);
  assert.match(serialized, /Front Door/);
  assert.doesNotMatch(
    serialized,
    /accessCodeMasked|unlockKey|ttlockKeyboardPwdId|ttlockKeyId|ttlockPayload|ttlockLockId/,
  );
});

test("real read adapter returns cleaning confirmation state without token or staff identity", async () => {
  const executor = new PinGoRuntimeReadToolExecutor(createPrismaFixture());
  const result = await executor.execute(
    "get_cleaning_status",
    {},
    request,
    createConversationMemory(request),
  );

  const serialized = JSON.stringify(result);
  assert.match(serialized, /CONFIRMED/);
  assert.doesNotMatch(serialized, /token|staffMemberId/);
});

test("real read adapter binds eligibility checks but still fails closed for unimplemented financial tools", async () => {
  const executor = new PinGoRuntimeReadToolExecutor(createPrismaFixture());

  const lateCheckout = await executor.execute(
    "check_late_checkout",
    { requestedLocalTime: "13:00" },
    request,
    createConversationMemory(request),
  );

  assert.equal(lateCheckout.authorizationGranted, false);

  await assert.rejects(
    executor.execute(
      "calculate_extension_price",
      {},
      request,
      createConversationMemory(request),
    ),
    /PIN_AI_RUNTIME_READ_TOOL_NOT_IMPLEMENTED:calculate_extension_price/,
  );
});
