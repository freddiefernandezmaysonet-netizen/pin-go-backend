import assert from "node:assert/strict";
import test from "node:test";
import {
  AccessStatus,
  GuestAccessReleaseStatus,
  GuestJourneyCoordinationIntentStatus,
  PaymentState,
  ReservationStatus,
  type PrismaClient,
} from "@prisma/client";

import {
  GUEST_ACCESS_PROVISION_OPERATION,
} from "../e14/guest-access-admission-fence.policy.e14";
import {
  adoptProviderCredentialUnderReservationFenceE15_1,
  quarantineActiveProviderOutcomeUnderReservationFenceE15_1,
  reconcileLateProviderSuccessUnderReservationFenceE15_1,
  rearmAmbiguousGrantUnderReservationFenceE15_1,
  reconcileAccessIntentUnderReservationFenceE15_1,
} from "./guest-access-reservation-reconciliation-fence.e15-1";

const now = new Date("2026-09-01T10:00:00.000Z");
const checkIn = new Date("2026-09-01T15:00:00.000Z");
const checkOut = new Date("2026-09-03T11:00:00.000Z");
const updatedAt = new Date("2026-09-01T09:55:00.000Z");

function marker(state: string) {
  return {
    e15: {
      version: "guest_access_ambiguity_reconciliation_e15_v1",
      state,
    },
  };
}

function grant(overrides: Record<string, unknown> = {}) {
  return {
    id: "g1",
    lockId: "lock-row-1",
    status: AccessStatus.PENDING,
    startsAt: checkIn,
    endsAt: checkOut,
    updatedAt,
    recoveryOperation: GUEST_ACCESS_PROVISION_OPERATION.AMBIGUOUS,
    recoveryAttemptCount: 2,
    recoveryNextAttemptAt: null,
    recoveryExhaustedAt: now,
    ttlockKeyboardPwdId: null,
    ttlockPayload: marker("ABSENCE_OBSERVED"),
    lock: { ttlockLockId: 101 },
    secureAccessCode: null,
    ...overrides,
  };
}

function reservation(overrides: Record<string, unknown> = {}) {
  return {
    id: "r1",
    propertyId: "p1",
    status: ReservationStatus.ACTIVE,
    paymentState: PaymentState.PAID,
    guestAccessReleaseStatus: GuestAccessReleaseStatus.ELIGIBLE,
    checkIn,
    checkOut,
    property: { organizationId: "o1" },
    accessGrants: [grant()],
    ...overrides,
  };
}

function buildDb(input: {
  reservation?: any;
  grantUpdateCounts?: number[];
  reservationUpdateCount?: number;
  intent?: any;
  intentUpdateCounts?: number[];
}) {
  const calls: string[] = [];
  const grantCounts = [...(input.grantUpdateCounts ?? [1])];
  const intentCounts = [...(input.intentUpdateCounts ?? [1])];
  let currentReservation = input.reservation ?? reservation();

  const tx: any = {
    $queryRawUnsafe: async (query: string) => {
      if (query.includes('FROM "Reservation"')) {
        calls.push("LOCK_RESERVATION");
        return [{ id: "r1" }];
      }
      if (query.includes('FROM "AccessGrant"')) {
        calls.push("LOCK_GRANTS");
        return [{ id: "g1" }];
      }
      throw new Error(`unexpected raw query: ${query}`);
    },
    reservation: {
      findUnique: async () => {
        calls.push("READ_RESERVATION");
        return currentReservation;
      },
      updateMany: async () => {
        calls.push("UPDATE_RESERVATION");
        return { count: input.reservationUpdateCount ?? 1 };
      },
    },
    accessGrant: {
      updateMany: async () => {
        calls.push("UPDATE_GRANT");
        return { count: grantCounts.shift() ?? 0 };
      },
    },
    accessCode: {
      upsert: async () => {
        calls.push("UPSERT_ACCESS_CODE");
        return { id: "code1" };
      },
    },
    guestJourneyCoordinationIntent: {
      findUnique: async () => {
        calls.push("READ_INTENT");
        return input.intent ?? null;
      },
      updateMany: async () => {
        calls.push("UPDATE_INTENT");
        return { count: intentCounts.shift() ?? 0 };
      },
    },
  };

  const db: any = {
    $transaction: async (callback: (inner: any) => Promise<any>, options: any) => {
      calls.push(`TX:${options?.isolationLevel ?? "none"}`);
      return callback(tx);
    },
  };

  return {
    prisma: db as PrismaClient,
    calls,
    setReservation(value: any) {
      currentReservation = value;
    },
  };
}

function adoptionInput() {
  return {
    grantId: "g1",
    reservationId: "r1",
    organizationId: "o1",
    propertyId: "p1",
    startsAt: checkIn,
    endsAt: checkOut,
    updatedAt,
    recoveryAttemptCount: 2,
    ttlockLockId: 101,
    now,
    keyboardPwdId: 5001,
    code: "1234567",
    maskedCode: "12*****",
    encryptedCode: "encrypted",
    hashedCode: "hashed",
    payload: marker("RECONCILED_PRESENT"),
    guestPhone: "+17875551212",
  };
}

function rearmInput() {
  return {
    grantId: "g1",
    reservationId: "r1",
    organizationId: "o1",
    propertyId: "p1",
    startsAt: checkIn,
    endsAt: checkOut,
    updatedAt,
    recoveryAttemptCount: 2,
    ttlockLockId: 101,
    now,
    payload: marker("REARMED"),
  };
}

function exhaustedIntent(overrides: Record<string, unknown> = {}) {
  return {
    id: "i1",
    reservationId: "r1",
    targetEngine: "ACCESS",
    intentType: "REQUEST_ACCESS_PROVISIONING",
    status: GuestJourneyCoordinationIntentStatus.EXHAUSTED,
    claimCount: 3,
    updatedAt,
    lastError: "ACCESS_PROVIDER_RESULT_AMBIGUOUS",
    ...overrides,
  };
}

function intentInput(controlledRearmEnabled = true) {
  return {
    intentId: "i1",
    reservationId: "r1",
    organizationId: "o1",
    propertyId: "p1",
    claimCount: 3,
    updatedAt,
    lastError: "ACCESS_PROVIDER_RESULT_AMBIGUOUS",
    controlledRearmEnabled,
    scope: { organizationIds: ["o1"], propertyIds: ["p1"] },
    now,
  };
}

test("E15.1 locks Reservation then all AccessGrant rows before adoption", async () => {
  const db = buildDb({});
  assert.equal(
    await adoptProviderCredentialUnderReservationFenceE15_1(db.prisma, adoptionInput()),
    true
  );
  assert.deepEqual(db.calls.slice(0, 4), [
    "TX:Serializable",
    "LOCK_RESERVATION",
    "LOCK_GRANTS",
    "READ_RESERVATION",
  ]);
  assert.ok(db.calls.indexOf("UPDATE_GRANT") < db.calls.indexOf("UPDATE_RESERVATION"));
});

test("E15.1 rejects cancellation drift after provider read", async () => {
  const db = buildDb({
    reservation: reservation({ status: ReservationStatus.CANCELLED }),
  });
  assert.equal(
    await adoptProviderCredentialUnderReservationFenceE15_1(db.prisma, adoptionInput()),
    false
  );
  assert.equal(db.calls.includes("UPDATE_GRANT"), false);
});

test("E15.1 rejects payment drift after provider read", async () => {
  const db = buildDb({
    reservation: reservation({ paymentState: PaymentState.REFUNDED }),
  });
  assert.equal(
    await adoptProviderCredentialUnderReservationFenceE15_1(db.prisma, adoptionInput()),
    false
  );
  assert.equal(db.calls.includes("UPDATE_GRANT"), false);
});

test("E15.1 rejects current-window date drift", async () => {
  const changedCheckOut = new Date("2026-09-04T11:00:00.000Z");
  const db = buildDb({
    reservation: reservation({ checkOut: changedCheckOut }),
  });
  assert.equal(
    await adoptProviderCredentialUnderReservationFenceE15_1(db.prisma, adoptionInput()),
    false
  );
  assert.equal(db.calls.includes("UPDATE_GRANT"), false);
});

test("E15.1 rejects two current-window pending grants", async () => {
  const db = buildDb({
    reservation: reservation({
      accessGrants: [grant(), grant({ id: "g2", updatedAt: new Date(updatedAt) })],
    }),
  });
  assert.equal(
    await rearmAmbiguousGrantUnderReservationFenceE15_1(db.prisma, rearmInput()),
    false
  );
  assert.equal(db.calls.includes("UPDATE_GRANT"), false);
});

test("E15.1 rejects a blocking active sibling even outside the current window", async () => {
  const db = buildDb({
    reservation: reservation({
      accessGrants: [
        grant(),
        grant({
          id: "g-old",
          status: AccessStatus.ACTIVE,
          startsAt: new Date("2026-08-20T15:00:00.000Z"),
          endsAt: new Date("2026-08-22T11:00:00.000Z"),
          recoveryOperation: null,
        }),
      ],
    }),
  });
  assert.equal(
    await rearmAmbiguousGrantUnderReservationFenceE15_1(db.prisma, rearmInput()),
    false
  );
});

test("E15.1 rejects TTLock lock binding drift", async () => {
  const db = buildDb({
    reservation: reservation({ accessGrants: [grant({ lock: { ttlockLockId: 202 } })] }),
  });
  assert.equal(
    await adoptProviderCredentialUnderReservationFenceE15_1(db.prisma, adoptionInput()),
    false
  );
});

test("E15.1 treats optimistic grant-version drift as a lost race", async () => {
  const db = buildDb({ grantUpdateCounts: [0] });
  assert.equal(
    await rearmAmbiguousGrantUnderReservationFenceE15_1(db.prisma, rearmInput()),
    false
  );
});

test("E15.1 fails the transaction when Reservation release CAS is lost", async () => {
  const db = buildDb({ reservationUpdateCount: 0 });
  await assert.rejects(
    adoptProviderCredentialUnderReservationFenceE15_1(db.prisma, adoptionInput()),
    /RESERVATION_RELEASE_CAS_LOST/
  );
});

test("E15.1 rearms only the canonical ambiguous grant", async () => {
  const db = buildDb({});
  assert.equal(
    await rearmAmbiguousGrantUnderReservationFenceE15_1(db.prisma, rearmInput()),
    true
  );
  assert.equal(db.calls.filter((value) => value === "UPDATE_GRANT").length, 1);
});

test("E15.1 reconciles an exhausted intent only from current-window released evidence", async () => {
  const activeGrant = grant({
    status: AccessStatus.ACTIVE,
    recoveryOperation: null,
    recoveryExhaustedAt: null,
    ttlockKeyboardPwdId: 5001,
    secureAccessCode: { id: "code1" },
  });
  const db = buildDb({
    reservation: reservation({
      guestAccessReleaseStatus: GuestAccessReleaseStatus.RELEASED,
      accessGrants: [activeGrant],
    }),
    intent: exhaustedIntent(),
  });
  const result = await reconcileAccessIntentUnderReservationFenceE15_1(
    db.prisma,
    intentInput()
  );
  assert.equal(result.action, "SUCCEEDED");
  assert.equal(result.grantId, "g1");
});

test("E15.1 refuses intent success from an active obsolete-window grant", async () => {
  const db = buildDb({
    reservation: reservation({
      guestAccessReleaseStatus: GuestAccessReleaseStatus.RELEASED,
      accessGrants: [grant({
        status: AccessStatus.ACTIVE,
        recoveryOperation: null,
        recoveryExhaustedAt: null,
        startsAt: new Date("2026-08-20T15:00:00.000Z"),
        endsAt: new Date("2026-08-22T11:00:00.000Z"),
        ttlockKeyboardPwdId: 5001,
        secureAccessCode: { id: "code1" },
      })],
    }),
    intent: exhaustedIntent(),
  });
  const result = await reconcileAccessIntentUnderReservationFenceE15_1(
    db.prisma,
    intentInput()
  );
  assert.equal(result.action, "UNCHANGED");
});

test("E15.1 rearms an intent only from its canonical current-window REARMED grant", async () => {
  const db = buildDb({
    reservation: reservation({
      accessGrants: [grant({
        recoveryOperation: GUEST_ACCESS_PROVISION_OPERATION.RETRYABLE,
        recoveryExhaustedAt: null,
        ttlockPayload: marker("REARMED"),
      })],
    }),
    intent: exhaustedIntent(),
  });
  const result = await reconcileAccessIntentUnderReservationFenceE15_1(
    db.prisma,
    intentInput(true)
  );
  assert.equal(result.action, "REARMED");
  assert.equal(result.grantId, "g1");
});

test("E15.1 will not rearm the intent when the controlled-rearm gate is off", async () => {
  const db = buildDb({
    reservation: reservation({
      accessGrants: [grant({
        recoveryOperation: GUEST_ACCESS_PROVISION_OPERATION.RETRYABLE,
        recoveryExhaustedAt: null,
        ttlockPayload: marker("REARMED"),
      })],
    }),
    intent: exhaustedIntent(),
  });
  const result = await reconcileAccessIntentUnderReservationFenceE15_1(
    db.prisma,
    intentInput(false)
  );
  assert.equal(result.action, "UNCHANGED");
  assert.equal(db.calls.includes("UPDATE_INTENT"), false);
});

test("E15.1 enforces hierarchical tenant/property scope for intent reconciliation", async () => {
  const db = buildDb({ intent: exhaustedIntent() });
  const result = await reconcileAccessIntentUnderReservationFenceE15_1(
    db.prisma,
    {
      ...intentInput(),
      scope: { organizationIds: ["other-org"], propertyIds: [] },
    }
  );
  assert.deepEqual(result, { action: "UNCHANGED", reason: "SCOPE_MISMATCH" });
  assert.equal(db.calls.length, 0);
});

test("E15.1 serializes a second replica through CAS after the first mutation", async () => {
  const db = buildDb({ grantUpdateCounts: [1, 0] });
  assert.equal(
    await rearmAmbiguousGrantUnderReservationFenceE15_1(db.prisma, rearmInput()),
    true
  );
  assert.equal(
    await rearmAmbiguousGrantUnderReservationFenceE15_1(db.prisma, rearmInput()),
    false
  );
});

test("Exit Closure A reconciles late provider success under the reservation fence", async () => {
  const db = buildDb({
    reservation: reservation({
      accessGrants: [grant({
        status: AccessStatus.ACTIVE,
        ttlockKeyboardPwdId: 5001,
        secureAccessCode: { id: "code1" },
        ttlockPayload: marker("VERIFYING_PROVIDER_STATE"),
      })],
    }),
  });

  assert.equal(
    await reconcileLateProviderSuccessUnderReservationFenceE15_1(
      db.prisma,
      {
        grantId: "g1",
        reservationId: "r1",
        organizationId: "o1",
        propertyId: "p1",
        startsAt: checkIn,
        endsAt: checkOut,
        updatedAt,
        recoveryAttemptCount: 2,
        ttlockLockId: 101,
        now,
        providerKeyboardPwdId: 5001,
        payload: marker("RECONCILED_PRESENT"),
      }
    ),
    true
  );
  assert.ok(db.calls.indexOf("LOCK_RESERVATION") < db.calls.indexOf("LOCK_GRANTS"));
  assert.ok(db.calls.indexOf("UPDATE_GRANT") < db.calls.indexOf("UPDATE_RESERVATION"));
});

test("Exit Closure A refuses late success when provider id contradicts durable local evidence", async () => {
  const db = buildDb({
    reservation: reservation({
      accessGrants: [grant({
        status: AccessStatus.ACTIVE,
        ttlockKeyboardPwdId: 5001,
        secureAccessCode: { id: "code1" },
      })],
    }),
  });

  assert.equal(
    await reconcileLateProviderSuccessUnderReservationFenceE15_1(
      db.prisma,
      {
        grantId: "g1",
        reservationId: "r1",
        organizationId: "o1",
        propertyId: "p1",
        startsAt: checkIn,
        endsAt: checkOut,
        updatedAt,
        recoveryAttemptCount: 2,
        ttlockLockId: 101,
        now,
        providerKeyboardPwdId: 9999,
        payload: marker("MANUAL_REVIEW_REQUIRED"),
      }
    ),
    false
  );
  assert.equal(db.calls.includes("UPDATE_GRANT"), false);
});


test("Closure A quarantines ACTIVE durable outcome after owner release CAS loss", async () => {
  const db = buildDb({
    reservation: reservation({
      accessGrants: [grant({
        status: AccessStatus.ACTIVE,
        recoveryOperation: null,
        recoveryAttemptCount: 0,
        ttlockKeyboardPwdId: 5001,
        secureAccessCode: { id: "code1" },
      })],
    }),
  });
  assert.equal(
    await quarantineActiveProviderOutcomeUnderReservationFenceE15_1(
      db.prisma,
      {
        grantId: "g1",
        reservationId: "r1",
        organizationId: "o1",
        propertyId: "p1",
        startsAt: checkIn,
        endsAt: checkOut,
        ttlockLockId: 101,
        now,
        reason: "GUEST_ACCESS_PROVISION_AMBIGUOUS:OWNER_RELEASE_PERSISTENCE_FENCE_LOST",
      }
    ),
    true
  );
  assert.deepEqual(db.calls.slice(0, 4), [
    "TX:Serializable",
    "LOCK_RESERVATION",
    "LOCK_GRANTS",
    "READ_RESERVATION",
  ]);
  assert.equal(db.calls.includes("UPDATE_RESERVATION"), false);
});
