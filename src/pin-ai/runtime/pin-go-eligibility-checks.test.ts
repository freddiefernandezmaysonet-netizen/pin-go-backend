import assert from "node:assert/strict";
import test from "node:test";

import type { PinAIRuntimeRequest } from "./contracts.js";
import { PinGoRuntimeEligibilityChecks } from "./pin-go-eligibility-checks.js";

const request: PinAIRuntimeRequest = {
  context: {
    organizationId: "org-a",
    propertyId: "property-a",
    reservationId: "reservation-a",
    guestId: "guest-a",
    currentLocalDateTime: "2026-09-20T10:00:00-04:00",
    preferredLanguage: "en",
  },
  conversation: [{ role: "guest", content: "Can I arrive early?" }],
};

function fixture(options?: {
  priorConflict?: boolean;
  cleaningStatus?: string | null;
  nextCheckIn?: Date | null;
  extensionConflict?: boolean;
  blockedDate?: boolean;
}) {
  let reservationCall = 0;
  return {
    reservation: {
      async findFirst(args: any) {
        reservationCall += 1;
        if (args?.where?.id === "reservation-a") {
          return {
            id: "reservation-a",
            propertyId: "property-a",
            checkIn: new Date("2026-09-20T20:00:00.000Z"),
            checkOut: new Date("2026-09-22T15:00:00.000Z"),
            property: {
              organizationId: "org-a",
              timezone: "America/Puerto_Rico",
              checkInTime: "16:00",
              checkOutTime: "11:00",
              cleaningDurationMinutes: 180,
            },
          };
        }

        if (args?.where?.checkOut?.gt) {
          if (options?.priorConflict) {
            return { checkOut: new Date("2026-09-20T18:00:00.000Z") };
          }
          if (options?.extensionConflict) {
            return {
              checkIn: new Date("2026-09-23T20:00:00.000Z"),
              checkOut: new Date("2026-09-25T15:00:00.000Z"),
            };
          }
          return null;
        }

        if (args?.where?.checkIn?.gte) {
          return options?.nextCheckIn
            ? { checkIn: options.nextCheckIn }
            : null;
        }

        return null;
      },
    },
    cleaningConfirmation: {
      async findFirst() {
        return options?.cleaningStatus
          ? {
              status: options.cleaningStatus,
              updatedAt: new Date("2026-09-20T15:00:00.000Z"),
            }
          : null;
      },
    },
    propertyBlockedDate: {
      async findFirst() {
        return options?.blockedDate
          ? {
              startDate: new Date("2026-09-23T04:00:00.000Z"),
              endDate: new Date("2026-09-24T04:00:00.000Z"),
              reason: "OWNER_BLOCK",
            }
          : null;
      },
    },
    reservationModification: {
      async findFirst() {
        return null;
      },
    },
  };
}

test("early check-in can become operationally available but is never auto-authorized", async () => {
  const checks = new PinGoRuntimeEligibilityChecks(
    fixture({ cleaningStatus: "CONFIRMED" }),
  );

  const result = await checks.checkEarlyCheckin(request, {
    requestedLocalTime: "14:00",
  });

  assert.equal(result.decision, "OPERATIONALLY_AVAILABLE_FOR_REVIEW");
  assert.equal(result.authorizationGranted, false);
});

test("early check-in remains unavailable while cleaning is not confirmed", async () => {
  const checks = new PinGoRuntimeEligibilityChecks(
    fixture({ cleaningStatus: "PENDING" }),
  );

  const result = await checks.checkEarlyCheckin(request, {
    requestedLocalTime: "14:00",
  });

  assert.equal(result.decision, "WAITING_FOR_CLEANING_READINESS");
  assert.equal(result.authorizationGranted, false);
});

test("late checkout preserves property cleaning duration before next stay", async () => {
  const checks = new PinGoRuntimeEligibilityChecks(
    fixture({
      nextCheckIn: new Date("2026-09-22T20:00:00.000Z"),
    }),
  );

  const result = await checks.checkLateCheckout(request, {
    requestedLocalTime: "14:00",
  });

  assert.equal(result.decision, "NOT_OPERATIONALLY_AVAILABLE");
  assert.equal(result.authorizationGranted, false);
});

test("extension availability remains a read-only calendar decision", async () => {
  const checks = new PinGoRuntimeEligibilityChecks(fixture());

  const result = await checks.checkExtensionAvailability(request, {
    additionalNights: 1,
  });

  assert.equal(result.decision, "CALENDAR_AVAILABLE_FOR_PRICING");
  assert.equal(result.authorizationGranted, false);
  assert.equal(result.pricingRequired, true);
});
