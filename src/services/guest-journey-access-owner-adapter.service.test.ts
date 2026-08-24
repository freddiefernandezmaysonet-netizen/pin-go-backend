import assert from "node:assert/strict";
import test from "node:test";

import {
  AccessMethod,
  AccessStatus,
  GuestAccessReleaseStatus,
  NfcAssignmentStatus,
  ReservationStatus,
} from "@prisma/client";

import { executeGuestJourneyAccessOwnerAdapter } from "./guest-journey-access-owner-adapter.service";
import type { ClaimedAccessIntent } from "./guest-journey-access-owner-runtime.service";

const now = new Date("2026-08-23T12:30:00.000Z");

function claim(
  intentType:
    | "REQUEST_ACCESS_PROVISIONING"
    | "REQUEST_ACCESS_REVOCATION_CHECK" = "REQUEST_ACCESS_PROVISIONING"
): ClaimedAccessIntent {
  return {
    intentId: "intent-1",
    intentKey: "key-1",
    reservationId: "reservation-1",
    journeyId: "journey-1",
    organizationId: "org-1",
    propertyId: "property-1",
    targetEngine: "ACCESS",
    intentType,
    expectedOutcomeCode: intentType === "REQUEST_ACCESS_PROVISIONING"
      ? "SECURE_GUEST_ACCESS_ACTIVE"
      : "ALL_GUEST_ACCESS_CLOSED",
    inputEvidenceFingerprint: "input-evidence",
    attemptNumber: 1,
    leaseToken: "lease-1",
    leaseExpiresAt: new Date(now.getTime() + 5 * 60_000),
  };
}

function snapshot(input: {
  status?: ReservationStatus;
  releaseStatus?: GuestAccessReleaseStatus;
  grantStatus?: AccessStatus;
  checkIn?: Date;
  checkOut?: Date;
  nfcStatus?: NfcAssignmentStatus | null;
  accessMode?: "PASSCODE_ONLY" | "PASSCODE_PLUS_NFC";
} = {}) {
  const checkIn = input.checkIn ?? new Date("2026-08-23T14:00:00.000Z");
  const checkOut = input.checkOut ?? new Date("2026-08-24T11:00:00.000Z");
  const grantStatus = input.grantStatus ?? AccessStatus.PENDING;
  return {
    id: "reservation-1",
    propertyId: "property-1",
    status: input.status ?? ReservationStatus.ACTIVE,
    checkIn,
    checkOut,
    guestAccessModeSnapshot: input.accessMode ?? "PASSCODE_ONLY",
    guestAccessReleaseStatus: input.releaseStatus ?? GuestAccessReleaseStatus.ELIGIBLE,
    guestAccessReleasedAt: grantStatus === AccessStatus.ACTIVE ? now : null,
    property: { organizationId: "org-1" },
    accessGrants: [{
      id: "grant-1",
      method: AccessMethod.PASSCODE_TIMEBOUND,
      status: grantStatus,
      startsAt: checkIn,
      endsAt: checkOut,
      ttlockKeyboardPwdId: grantStatus === AccessStatus.ACTIVE ? 123 : null,
      recoveryOperation: null,
      recoveryAttemptCount: 0,
      recoveryNextAttemptAt: null,
      recoveryExhaustedAt: null,
      secureAccessCode: grantStatus === AccessStatus.ACTIVE ? { id: "code-1" } : null,
      lock: { ttlockLockId: 987 },
    }],
    NfcAssignment: input.nfcStatus
      ? [{ id: "nfc-1", status: input.nfcStatus }]
      : [],
  };
}

function fakePrisma(
  state: ReturnType<typeof snapshot>,
  releaseUpdateCount = 1
) {
  return {
    reservation: {
      findUnique: async () => state,
      updateMany: async ({ data }: any) => {
        if (releaseUpdateCount === 1) Object.assign(state, data);
        return { count: releaseUpdateCount };
      },
    },
  } as any;
}

function provisioningDependencies(
  state: ReturnType<typeof snapshot>,
  overrides: Record<string, unknown> = {}
) {
  return {
    isEntitled: async () => ({ ok: true, reason: "ENTITLED" }),
    assertTenantProviderAuth: async () => undefined,
    activate: async (grantId: string) => {
      assert.equal(grantId, "grant-1");
      state.accessGrants[0].status = AccessStatus.ACTIVE;
      state.accessGrants[0].ttlockKeyboardPwdId = 123;
      state.accessGrants[0].secureAccessCode = { id: "code-1" };
      return { ok: true, keyboardPwdId: 123 } as any;
    },
    assignNfc: async () => [],
    ...overrides,
  } as any;
}

test("E8 provisions exactly one canonical grant without exposing or recreating passcode logic", async () => {
  const state = snapshot();
  let calls = 0;
  const dependencies = provisioningDependencies(state, {
    activate: async () => {
      calls += 1;
      state.accessGrants[0].status = AccessStatus.ACTIVE;
      state.accessGrants[0].ttlockKeyboardPwdId = 123;
      state.accessGrants[0].secureAccessCode = { id: "code-1" };
      return { ok: true };
    },
  });
  const result = await executeGuestJourneyAccessOwnerAdapter(
    fakePrisma(state),
    claim(),
    {
      now,
      provisionLeadMs: 2 * 60 * 60_000,
      providerTimeoutMs: 100,
      dependencies,
    }
  );
  assert.equal(result.completion.kind, "SUCCEEDED");
  if (result.completion.kind === "SUCCEEDED") {
    assert.equal(result.completion.action, "PROVISIONED");
  }
  assert.equal(calls, 1);
  assert.equal(state.guestAccessReleaseStatus, GuestAccessReleaseStatus.RELEASED);
  assert.equal(result.providerCalls, 1);
});

test("E8 preserves complementary NFC count and schedules it without TTLock execution", async () => {
  const state = snapshot({
    accessMode: "PASSCODE_PLUS_NFC",
    nfcStatus: NfcAssignmentStatus.FAILED,
  });
  let nfcInput: any = null;
  const result = await executeGuestJourneyAccessOwnerAdapter(
    fakePrisma(state),
    claim(),
    {
      now,
      provisionLeadMs: 2 * 60 * 60_000,
      providerTimeoutMs: 100,
      dependencies: provisioningDependencies(state, {
        assignNfc: async (_prisma: unknown, input: unknown) => {
          nfcInput = input;
          return [];
        },
      }),
    }
  );
  assert.equal(result.completion.kind, "SUCCEEDED");
  assert.equal(nfcInput?.count, 1);
  assert.equal(nfcInput?.skipTtlock, true);
  assert.equal(nfcInput?.startsAt.toISOString(), state.checkIn.toISOString());
  assert.equal(nfcInput?.endsAt.toISOString(), state.checkOut.toISOString());
  assert.equal(result.providerCalls, 1);
});

test("E8 deduplicates already-provisioned evidence with zero provider calls", async () => {
  const state = snapshot({
    grantStatus: AccessStatus.ACTIVE,
    releaseStatus: GuestAccessReleaseStatus.RELEASED,
  });
  let calls = 0;
  const result = await executeGuestJourneyAccessOwnerAdapter(
    fakePrisma(state),
    claim(),
    {
      now,
      provisionLeadMs: 2 * 60 * 60_000,
      providerTimeoutMs: 100,
      dependencies: provisioningDependencies(state, {
        activate: async () => { calls += 1; return { ok: true }; },
      }),
    }
  );
  assert.equal(result.completion.kind, "SUCCEEDED");
  if (result.completion.kind === "SUCCEEDED") {
    assert.equal(result.completion.action, "ALREADY_SATISFIED");
  }
  assert.equal(calls, 0);
  assert.equal(result.providerCalls, 0);
});

test("E8 preserves the two-hour provisioning window", async () => {
  const state = snapshot({ checkIn: new Date("2026-08-23T18:00:00.000Z") });
  let calls = 0;
  const result = await executeGuestJourneyAccessOwnerAdapter(
    fakePrisma(state),
    claim(),
    {
      now,
      provisionLeadMs: 2 * 60 * 60_000,
      providerTimeoutMs: 100,
      dependencies: provisioningDependencies(state, {
        activate: async () => { calls += 1; return { ok: true }; },
      }),
    }
  );
  assert.equal(result.completion.kind, "RETRYABLE");
  if (result.completion.kind === "RETRYABLE") {
    assert.equal(result.completion.errorCode, "ACCESS_PROVISIONING_WINDOW_NOT_OPEN");
    assert.equal(result.completion.retryAt?.toISOString(), "2026-08-23T16:00:00.000Z");
  }
  assert.equal(calls, 0);
});

test("E8 preserves canonical billing entitlement before activateGrant", async () => {
  const state = snapshot();
  let calls = 0;
  const result = await executeGuestJourneyAccessOwnerAdapter(
    fakePrisma(state),
    claim(),
    {
      now,
      provisionLeadMs: 2 * 60 * 60_000,
      providerTimeoutMs: 100,
      dependencies: provisioningDependencies(state, {
        isEntitled: async () => ({ ok: false, reason: "NO_SUBSCRIPTION" }),
        activate: async () => { calls += 1; return { ok: true }; },
      }),
    }
  );
  assert.equal(result.completion.kind, "RETRYABLE");
  if (result.completion.kind === "RETRYABLE") {
    assert.equal(
      result.completion.errorCode,
      "ACCESS_PROVISIONING_ORGANIZATION_NOT_ENTITLED"
    );
  }
  assert.equal(calls, 0);
  assert.equal(result.providerCalls, 0);
});

test("E8 blocks provisioning before activateGrant when tenant TTLock auth is missing", async () => {
  const state = snapshot();
  let calls = 0;
  const result = await executeGuestJourneyAccessOwnerAdapter(
    fakePrisma(state),
    claim(),
    {
      now,
      provisionLeadMs: 2 * 60 * 60_000,
      providerTimeoutMs: 100,
      dependencies: provisioningDependencies(state, {
        assertTenantProviderAuth: async () => {
          throw new Error("TTLockAuth not configured for this organization");
        },
        activate: async () => { calls += 1; return { ok: true }; },
      }),
    }
  );
  assert.equal(result.completion.kind, "WAITING_FOR_EVIDENCE");
  if (result.completion.kind === "WAITING_FOR_EVIDENCE") {
    assert.equal(
      result.completion.errorCode,
      "ACCESS_TENANT_TTLOCK_AUTH_MISSING"
    );
  }
  assert.equal(calls, 0);
  assert.equal(result.providerCalls, 0);
});

test("E8 fences an ambiguous provisioning result and never requests automatic replay", async () => {
  const state = snapshot();
  const result = await executeGuestJourneyAccessOwnerAdapter(
    fakePrisma(state),
    claim(),
    {
      now,
      provisionLeadMs: 2 * 60 * 60_000,
      providerTimeoutMs: 5,
      dependencies: provisioningDependencies(state, {
        activate: async () => new Promise(() => {}),
      }),
    }
  );
  assert.equal(result.completion.kind, "AMBIGUOUS");
  if (result.completion.kind === "AMBIGUOUS") {
    assert.equal(result.completion.errorCode, "ACCESS_PROVISIONING_PROVIDER_RESULT_AMBIGUOUS");
  }
  assert.equal(state.accessGrants[0].status, AccessStatus.PENDING);
});

test("E8 fences a canonical activation whose RELEASED transition loses its CAS", async () => {
  const state = snapshot();
  const result = await executeGuestJourneyAccessOwnerAdapter(
    fakePrisma(state, 0),
    claim(),
    {
      now,
      provisionLeadMs: 2 * 60 * 60_000,
      providerTimeoutMs: 100,
      dependencies: provisioningDependencies(state),
    }
  );
  assert.equal(result.completion.kind, "AMBIGUOUS");
  if (result.completion.kind === "AMBIGUOUS") {
    assert.equal(
      result.completion.errorCode,
      "ACCESS_PROVISIONING_RELEASE_PERSISTENCE_FENCE_LOST"
    );
  }
  assert.equal(result.providerCalls, 1);
});

test("E8 fails closed on tenant drift before canonical provider execution", async () => {
  const state = snapshot();
  state.property.organizationId = "other-org";
  let calls = 0;
  await assert.rejects(
    executeGuestJourneyAccessOwnerAdapter(
      fakePrisma(state),
      claim(),
      {
        now,
        provisionLeadMs: 2 * 60 * 60_000,
        providerTimeoutMs: 100,
        dependencies: provisioningDependencies(state, {
          activate: async () => { calls += 1; return { ok: true }; },
        }),
      }
    ),
    /RESERVATION_SCOPE_MISMATCH/
  );
  assert.equal(calls, 0);
});

function revocationDependencies(
  state: ReturnType<typeof snapshot>,
  overrides: Record<string, unknown> = {}
) {
  return {
    assertTenantProviderAuth: async () => undefined,
    claimRecovery: async () => ({
      claimed: true,
      attemptCount: 1,
      claimedAt: now,
      leaseUntil: new Date(now.getTime() + 5 * 60_000),
    }),
    deactivate: async () => {
      state.accessGrants[0].status = AccessStatus.REVOKED;
      return { ok: true };
    },
    recordRecoveryFailure: async () => ({
      applied: true,
      exhausted: false,
      nextAttemptAt: new Date(now.getTime() + 60_000),
      attemptCount: 1,
      lastError: "failure",
    }),
    recordRecoverySuccess: async () => ({ applied: true }),
    unassignGuestNfc: async () => ({ ended: 0, totalActive: 0 }),
    ...overrides,
  } as any;
}

test("E8 revokes through canonical recovery and deactivateGrant boundaries", async () => {
  const state = snapshot({
    grantStatus: AccessStatus.ACTIVE,
    releaseStatus: GuestAccessReleaseStatus.RELEASED,
    checkOut: new Date("2026-08-23T11:00:00.000Z"),
  });
  let deactivateCalls = 0;
  let successCalls = 0;
  const dependencies = revocationDependencies(state, {
    deactivate: async () => {
      deactivateCalls += 1;
      state.accessGrants[0].status = AccessStatus.REVOKED;
      return { ok: true };
    },
    recordRecoverySuccess: async () => {
      successCalls += 1;
      return { applied: true };
    },
  });
  const result = await executeGuestJourneyAccessOwnerAdapter(
    fakePrisma(state),
    claim("REQUEST_ACCESS_REVOCATION_CHECK"),
    {
      now,
      provisionLeadMs: 2 * 60 * 60_000,
      providerTimeoutMs: 100,
      dependencies,
    }
  );
  assert.equal(result.completion.kind, "SUCCEEDED");
  if (result.completion.kind === "SUCCEEDED") {
    assert.equal(result.completion.action, "REVOKED");
  }
  assert.equal(deactivateCalls, 1);
  assert.equal(successCalls, 1);
});

test("E8 closes never-released zero-grant access without provider calls", async () => {
  const state = snapshot({
    releaseStatus: GuestAccessReleaseStatus.ELIGIBLE,
    checkOut: new Date("2026-08-23T11:00:00.000Z"),
  });
  state.accessGrants = [];
  let calls = 0;
  const result = await executeGuestJourneyAccessOwnerAdapter(
    fakePrisma(state),
    claim("REQUEST_ACCESS_REVOCATION_CHECK"),
    {
      now,
      provisionLeadMs: 2 * 60 * 60_000,
      providerTimeoutMs: 100,
      dependencies: revocationDependencies(state, {
        deactivate: async () => { calls += 1; return { ok: true }; },
        unassignGuestNfc: async () => {
          calls += 1;
          return { ended: 0, totalActive: 0 };
        },
      }),
    }
  );
  assert.equal(result.completion.kind, "SUCCEEDED");
  if (result.completion.kind === "SUCCEEDED") {
    assert.equal(result.completion.action, "ALREADY_SATISFIED");
  }
  assert.equal(calls, 0);
  assert.equal(result.providerCalls, 0);
});

test("E8 keeps released zero-grant access ambiguous instead of closing by absence", async () => {
  const state = snapshot({
    releaseStatus: GuestAccessReleaseStatus.RELEASED,
    checkOut: new Date("2026-08-23T11:00:00.000Z"),
  });
  state.accessGrants = [];
  const result = await executeGuestJourneyAccessOwnerAdapter(
    fakePrisma(state),
    claim("REQUEST_ACCESS_REVOCATION_CHECK"),
    {
      now,
      provisionLeadMs: 2 * 60 * 60_000,
      providerTimeoutMs: 100,
      dependencies: revocationDependencies(state),
    }
  );
  assert.equal(result.completion.kind, "AMBIGUOUS");
  if (result.completion.kind === "AMBIGUOUS") {
    assert.equal(
      result.completion.errorCode,
      "ACCESS_CLOSURE_EVIDENCE_INCOMPLETE"
    );
  }
  assert.equal(result.providerCalls, 0);
});

test("E8 honors canonical recovery backoff without calling deactivateGrant", async () => {
  const state = snapshot({
    grantStatus: AccessStatus.ACTIVE,
    releaseStatus: GuestAccessReleaseStatus.RELEASED,
    checkOut: new Date("2026-08-23T11:00:00.000Z"),
  });
  const retryAt = new Date(now.getTime() + 5 * 60_000);
  let calls = 0;
  const result = await executeGuestJourneyAccessOwnerAdapter(
    fakePrisma(state),
    claim("REQUEST_ACCESS_REVOCATION_CHECK"),
    {
      now,
      provisionLeadMs: 2 * 60 * 60_000,
      providerTimeoutMs: 100,
      dependencies: revocationDependencies(state, {
        claimRecovery: async () => ({
          claimed: false,
          reason: "RECOVERY_NOT_DUE",
          nextAttemptAt: retryAt,
        }),
        deactivate: async () => { calls += 1; return { ok: true }; },
      }),
    }
  );
  assert.equal(result.completion.kind, "RETRYABLE");
  if (result.completion.kind === "RETRYABLE") {
    assert.equal(result.completion.retryAt?.toISOString(), retryAt.toISOString());
  }
  assert.equal(calls, 0);
});

test("E8 blocks revocation before deactivateGrant when tenant TTLock auth is missing", async () => {
  const state = snapshot({
    grantStatus: AccessStatus.ACTIVE,
    releaseStatus: GuestAccessReleaseStatus.RELEASED,
    checkOut: new Date("2026-08-23T11:00:00.000Z"),
  });
  let calls = 0;
  const result = await executeGuestJourneyAccessOwnerAdapter(
    fakePrisma(state),
    claim("REQUEST_ACCESS_REVOCATION_CHECK"),
    {
      now,
      provisionLeadMs: 2 * 60 * 60_000,
      providerTimeoutMs: 100,
      dependencies: revocationDependencies(state, {
        assertTenantProviderAuth: async () => {
          throw new Error("TTLockAuth not configured for this organization");
        },
        deactivate: async () => { calls += 1; return { ok: true }; },
      }),
    }
  );
  assert.equal(result.completion.kind, "WAITING_FOR_EVIDENCE");
  if (result.completion.kind === "WAITING_FOR_EVIDENCE") {
    assert.equal(
      result.completion.errorCode,
      "ACCESS_TENANT_TTLOCK_AUTH_MISSING"
    );
  }
  assert.equal(calls, 0);
  assert.equal(result.providerCalls, 0);
});

test("E8 closes complementary guest NFC through the existing canonical service", async () => {
  const state = snapshot({
    grantStatus: AccessStatus.ACTIVE,
    releaseStatus: GuestAccessReleaseStatus.RELEASED,
    checkOut: new Date("2026-08-23T11:00:00.000Z"),
    nfcStatus: NfcAssignmentStatus.ACTIVE,
  });
  let nfcCalls = 0;
  const result = await executeGuestJourneyAccessOwnerAdapter(
    fakePrisma(state),
    claim("REQUEST_ACCESS_REVOCATION_CHECK"),
    {
      now,
      provisionLeadMs: 2 * 60 * 60_000,
      providerTimeoutMs: 100,
      dependencies: revocationDependencies(state, {
        unassignGuestNfc: async () => {
          nfcCalls += 1;
          state.NfcAssignment[0].status = NfcAssignmentStatus.ENDED;
          return { ended: 1, totalActive: 1 };
        },
      }),
    }
  );
  assert.equal(result.completion.kind, "SUCCEEDED");
  assert.equal(nfcCalls, 1);
});

test("E8 blocks NFC revocation before unassign when tenant TTLock auth is missing", async () => {
  const state = snapshot({
    grantStatus: AccessStatus.REVOKED,
    releaseStatus: GuestAccessReleaseStatus.RELEASED,
    checkOut: new Date("2026-08-23T11:00:00.000Z"),
    nfcStatus: NfcAssignmentStatus.ACTIVE,
  });
  let nfcCalls = 0;
  const result = await executeGuestJourneyAccessOwnerAdapter(
    fakePrisma(state),
    claim("REQUEST_ACCESS_REVOCATION_CHECK"),
    {
      now,
      provisionLeadMs: 2 * 60 * 60_000,
      providerTimeoutMs: 100,
      dependencies: revocationDependencies(state, {
        assertTenantProviderAuth: async () => {
          throw new Error("TTLockAuth not configured for this organization");
        },
        unassignGuestNfc: async () => {
          nfcCalls += 1;
          return { ended: 1, totalActive: 1 };
        },
      }),
    }
  );
  assert.equal(result.completion.kind, "WAITING_FOR_EVIDENCE");
  if (result.completion.kind === "WAITING_FOR_EVIDENCE") {
    assert.equal(
      result.completion.errorCode,
      "ACCESS_TENANT_TTLOCK_AUTH_MISSING"
    );
  }
  assert.equal(nfcCalls, 0);
  assert.equal(result.providerCalls, 0);
});

test("E8 fences an ambiguous revocation and records canonical recovery failure", async () => {
  const state = snapshot({
    grantStatus: AccessStatus.ACTIVE,
    releaseStatus: GuestAccessReleaseStatus.RELEASED,
    checkOut: new Date("2026-08-23T11:00:00.000Z"),
  });
  let failureCalls = 0;
  const result = await executeGuestJourneyAccessOwnerAdapter(
    fakePrisma(state),
    claim("REQUEST_ACCESS_REVOCATION_CHECK"),
    {
      now,
      provisionLeadMs: 2 * 60 * 60_000,
      providerTimeoutMs: 5,
      dependencies: revocationDependencies(state, {
        deactivate: async () => new Promise(() => {}),
        recordRecoveryFailure: async () => {
          failureCalls += 1;
          return {
            applied: true,
            exhausted: false,
            nextAttemptAt: new Date(now.getTime() + 60_000),
            attemptCount: 1,
            lastError: "timeout",
          };
        },
      }),
    }
  );
  assert.equal(result.completion.kind, "AMBIGUOUS");
  assert.equal(failureCalls, 1);
});

test("E8 fences incomplete closure evidence after canonical revocation", async () => {
  const state = snapshot({
    grantStatus: AccessStatus.ACTIVE,
    releaseStatus: GuestAccessReleaseStatus.RELEASED,
    checkOut: new Date("2026-08-23T11:00:00.000Z"),
  });
  const result = await executeGuestJourneyAccessOwnerAdapter(
    fakePrisma(state),
    claim("REQUEST_ACCESS_REVOCATION_CHECK"),
    {
      now,
      provisionLeadMs: 2 * 60 * 60_000,
      providerTimeoutMs: 100,
      dependencies: revocationDependencies(state, {
        deactivate: async () => ({ ok: true }),
      }),
    }
  );
  assert.equal(result.completion.kind, "AMBIGUOUS");
  if (result.completion.kind === "AMBIGUOUS") {
    assert.equal(
      result.completion.errorCode,
      "ACCESS_CLOSURE_EVIDENCE_INCOMPLETE"
    );
  }
  assert.equal(result.providerCalls, 1);
});
