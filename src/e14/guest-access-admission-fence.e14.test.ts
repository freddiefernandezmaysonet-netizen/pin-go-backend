import assert from "node:assert/strict";
import test from "node:test";

import {
  GUEST_ACCESS_PROVISION_OPERATION,
  buildGuestAccessProvisionExecutingOperation,
  classifyGuestAccessProviderFailure,
  guestAccessProvisionClaimableWhere,
  parseGuestAccessProvisionFenceState,
} from "./guest-access-admission-fence.policy.e14.js";
import {
  beginGuestAccessProvisioningExecution,
  claimGuestAccessProvisioning,
  completeGuestAccessProvisioningFailure,
  completeGuestAccessProvisioningSuccess,
  executeGuestAccessProvisioningWithFence,
  recoverStaleGuestAccessProvisioningFences,
  type GuestAccessProvisionClaim,
} from "./guest-access-admission-fence.service.e14.js";

const NOW = new Date("2026-08-27T00:00:00.000Z");

function clone<T>(value: T): T {
  return structuredClone(value);
}

function sameValue(left: any, right: any): boolean {
  if (left instanceof Date || right instanceof Date) {
    return (
      left instanceof Date &&
      right instanceof Date &&
      left.getTime() === right.getTime()
    );
  }
  return left === right;
}

function matchesWhere(row: any, where: any): boolean {
  if (!where) return true;

  for (const [key, expected] of Object.entries(where)) {
    if (key === "OR") {
      if (!(expected as any[]).some((item) => matchesWhere(row, item))) {
        return false;
      }
      continue;
    }

    if (key === "AND") {
      if (!(expected as any[]).every((item) => matchesWhere(row, item))) {
        return false;
      }
      continue;
    }

    if (key === "reservation") {
      const relationWhere = (expected as any).is ?? expected;
      if (!matchesWhere(row.reservation, relationWhere)) return false;
      continue;
    }

    const actual = row[key];
    if (
      expected &&
      typeof expected === "object" &&
      !(expected instanceof Date)
    ) {
      const operator = expected as any;
      if ("gt" in operator) {
        if (!(actual instanceof Date) || actual.getTime() <= operator.gt.getTime()) {
          return false;
        }
        continue;
      }
      if ("lte" in operator) {
        if (!(actual instanceof Date) || actual.getTime() > operator.lte.getTime()) {
          return false;
        }
        continue;
      }
      if ("startsWith" in operator) {
        if (typeof actual !== "string" || !actual.startsWith(operator.startsWith)) {
          return false;
        }
        continue;
      }
      if ("in" in operator) {
        if (!operator.in.includes(actual)) return false;
        continue;
      }
    }

    if (!sameValue(actual, expected)) return false;
  }

  return true;
}

class MemoryFenceDb {
  row: any;

  constructor(row: any) {
    this.row = row;
  }

  accessGrant: any = {
    findUnique: async () => undefined,
    findMany: async () => undefined,
    updateMany: async () => undefined,
  };

  init() {
    this.accessGrant.findUnique = async ({ where }: any) =>
      where.id === this.row.id ? clone(this.row) : null;
    this.accessGrant.findMany = async ({ where }: any) =>
      matchesWhere(this.row, where) ? [clone(this.row)] : [];
    this.accessGrant.updateMany = async ({ where, data }: any) => {
      if (!matchesWhere(this.row, where)) return { count: 0 };
      Object.assign(this.row, data);
      return { count: 1 };
    };
    return this;
  }
}

function pendingGrant(overrides: Record<string, unknown> = {}) {
  return {
    id: "grant-1",
    status: "PENDING",
    recoveryOperation: null,
    recoveryAttemptCount: 0,
    recoveryLastAttemptAt: null,
    recoveryNextAttemptAt: null,
    recoveryExhaustedAt: null,
    lastError: null,
    ttlockKeyboardPwdId: null,
    secureAccessCode: null,
    reservation: {
      id: "reservation-1",
      status: "ACTIVE",
      paymentState: "PAID",
      guestAccessReleaseStatus: "ELIGIBLE",
      checkOut: new Date("2026-08-28T00:00:00.000Z"),
    },
    ...overrides,
  };
}

test("100 blocked cycles produce zero provider admission claims", async () => {
  const db = new MemoryFenceDb(
    pendingGrant({
      reservation: {
        id: "reservation-1",
        status: "ACTIVE",
        paymentState: "PAID",
        guestAccessReleaseStatus: "BLOCKED",
        checkOut: new Date("2026-08-28T00:00:00.000Z"),
      },
    })
  ).init();

  let providerExecutions = 0;

  for (let index = 0; index < 100; index += 1) {
    const result = await claimGuestAccessProvisioning(db, {
      accessGrantId: "grant-1",
      reservationId: "reservation-1",
      ownerId: `replica-${index % 2}`,
      now: NOW,
    });

    if (result.claimed) providerExecutions += 1;
    else assert.equal(result.reason, "NOT_ELIGIBLE");
  }

  assert.equal(providerExecutions, 0);
  assert.equal(db.row.recoveryAttemptCount, 0);
  assert.equal(db.row.recoveryOperation, null);
});



test("fresh readiness race blocks the physical callback after a durable claim", async () => {
  const db = new MemoryFenceDb(pendingGrant()).init();
  let providerExecutions = 0;

  const result = await executeGuestAccessProvisioningWithFence(db, {
    accessGrantId: "grant-1",
    reservationId: "reservation-1",
    ownerId: "replica-a",
    now: NOW,
    evaluateReadiness: async () => ({
      ready: false,
      blockers: ["WITHHELD_FROM_HOST"],
    }),
    executePhysical: async () => {
      providerExecutions += 1;
      return { ok: true };
    },
  });

  assert.equal(result.status, "WAITING_FOR_EVIDENCE");
  assert.equal(providerExecutions, 0);
  assert.equal(db.row.recoveryOperation, null);
  assert.equal(db.row.recoveryAttemptCount, 0);
  assert.equal(db.row.recoveryLastAttemptAt, null);
});

test("claim rejects a reservation mismatch before any physical ownership is acquired", async () => {
  const db = new MemoryFenceDb(pendingGrant()).init();

  const result = await claimGuestAccessProvisioning(db, {
    accessGrantId: "grant-1",
    reservationId: "reservation-other",
    ownerId: "replica-a",
    now: NOW,
  });

  assert.equal(result.claimed, false);
  if (!result.claimed) {
    assert.equal(result.reason, "RESERVATION_MISMATCH");
  }
  assert.equal(db.row.recoveryOperation, null);
  assert.equal(db.row.recoveryAttemptCount, 0);
});

test("readiness evaluation exceptions remain pre-boundary retryable with zero provider calls", async () => {
  const db = new MemoryFenceDb(pendingGrant()).init();
  let providerExecutions = 0;

  const result = await executeGuestAccessProvisioningWithFence(db, {
    accessGrantId: "grant-1",
    reservationId: "reservation-1",
    ownerId: "replica-a",
    now: NOW,
    evaluateReadiness: async () => {
      throw new Error("READINESS_DATABASE_UNAVAILABLE");
    },
    executePhysical: async () => {
      providerExecutions += 1;
      return { ok: true };
    },
  });

  assert.equal(result.status, "RETRYABLE");
  assert.equal(providerExecutions, 0);
  assert.equal(
    db.row.recoveryOperation,
    GUEST_ACCESS_PROVISION_OPERATION.RETRYABLE
  );
  assert.ok(db.row.recoveryNextAttemptAt > NOW);
  assert.match(
    String(db.row.lastError),
    /PRE_BOUNDARY_RETRYABLE/
  );
});

test("two replicas racing for one eligible grant produce one claim winner", async () => {
  const db = new MemoryFenceDb(pendingGrant()).init();

  const results = await Promise.all([
    claimGuestAccessProvisioning(db, {
      accessGrantId: "grant-1",
      reservationId: "reservation-1",
      ownerId: "replica-a",
      now: NOW,
    }),
    claimGuestAccessProvisioning(db, {
      accessGrantId: "grant-1",
      reservationId: "reservation-1",
      ownerId: "replica-b",
      now: NOW,
    }),
  ]);

  assert.equal(results.filter((item) => item.claimed).length, 1);
  assert.equal(db.row.recoveryAttemptCount, 1);
  assert.equal(
    parseGuestAccessProvisionFenceState(db.row.recoveryOperation),
    "CLAIMED"
  );
  assert.equal(String(db.row.recoveryOperation).includes("replica-a"), false);
  assert.equal(String(db.row.recoveryOperation).includes("replica-b"), false);
});

test("execution begins only for the exact claim fingerprint and live lease", async () => {
  const db = new MemoryFenceDb(pendingGrant()).init();
  const claimed = await claimGuestAccessProvisioning(db, {
    accessGrantId: "grant-1",
    reservationId: "reservation-1",
    ownerId: "replica-a",
    now: NOW,
  });
  assert.equal(claimed.claimed, true);
  if (!claimed.claimed) return;

  const wrongClaim: GuestAccessProvisionClaim = {
    ...claimed.claim,
    executingOperation:
      buildGuestAccessProvisionExecutingOperation("0".repeat(64)),
  };

  const wrong = await beginGuestAccessProvisioningExecution(db, {
    claim: wrongClaim,
    now: NOW,
  });
  assert.equal(wrong.started, false);

  const right = await beginGuestAccessProvisioningExecution(db, {
    claim: claimed.claim,
    now: NOW,
  });
  assert.equal(right.started, true);
  assert.equal(
    parseGuestAccessProvisionFenceState(db.row.recoveryOperation),
    "EXECUTING"
  );
});

test("a stale pre-execution claim becomes retryable, never ambiguous", async () => {
  const db = new MemoryFenceDb(
    pendingGrant({
      recoveryOperation:
        "GUEST_ACCESS_PROVISION_CLAIMED:" + "1".repeat(64),
      recoveryAttemptCount: 1,
      recoveryLastAttemptAt: new Date(NOW.getTime() - 10 * 60_000),
      recoveryNextAttemptAt: new Date(NOW.getTime() - 1),
    })
  ).init();

  const result = await recoverStaleGuestAccessProvisioningFences(db, {
    now: NOW,
  });

  assert.equal(result.retryable, 1);
  assert.equal(result.ambiguous, 0);
  assert.equal(
    db.row.recoveryOperation,
    GUEST_ACCESS_PROVISION_OPERATION.RETRYABLE
  );
  assert.ok(db.row.recoveryNextAttemptAt > NOW);
});

test("a malformed claim without a lease is recovered instead of blocking forever", async () => {
  const db = new MemoryFenceDb(
    pendingGrant({
      recoveryOperation:
        "GUEST_ACCESS_PROVISION_CLAIMED:" + "4".repeat(64),
      recoveryAttemptCount: 1,
      recoveryLastAttemptAt: new Date(NOW.getTime() - 10 * 60_000),
      recoveryNextAttemptAt: null,
    })
  ).init();

  const result = await recoverStaleGuestAccessProvisioningFences(db, {
    now: NOW,
  });

  assert.equal(result.retryable, 1);
  assert.equal(
    db.row.recoveryOperation,
    GUEST_ACCESS_PROVISION_OPERATION.RETRYABLE
  );
});

test("a stale ACTIVE execution with complete durable evidence reconciles as success", async () => {
  const db = new MemoryFenceDb(
    pendingGrant({
      status: "ACTIVE",
      recoveryOperation:
        "GUEST_ACCESS_PROVISION_EXECUTING:" + "3".repeat(64),
      recoveryAttemptCount: 2,
      recoveryLastAttemptAt: new Date(NOW.getTime() - 10 * 60_000),
      recoveryNextAttemptAt: new Date(NOW.getTime() - 1),
      ttlockKeyboardPwdId: 123,
      secureAccessCode: { id: "code-1" },
    })
  ).init();

  const result = await recoverStaleGuestAccessProvisioningFences(db, {
    now: NOW,
  });

  assert.equal(result.reconciledSuccess, 1);
  assert.equal(result.ambiguous, 0);
  assert.equal(db.row.recoveryOperation, null);
  assert.equal(db.row.recoveryAttemptCount, 0);
});

test("a stale executing lease is quarantined as ambiguous with no replay", async () => {
  const db = new MemoryFenceDb(
    pendingGrant({
      recoveryOperation:
        "GUEST_ACCESS_PROVISION_EXECUTING:" + "2".repeat(64),
      recoveryAttemptCount: 2,
      recoveryLastAttemptAt: new Date(NOW.getTime() - 10 * 60_000),
      recoveryNextAttemptAt: new Date(NOW.getTime() - 1),
    })
  ).init();

  const result = await recoverStaleGuestAccessProvisioningFences(db, {
    now: NOW,
  });

  assert.equal(result.ambiguous, 1);
  assert.equal(
    db.row.recoveryOperation,
    GUEST_ACCESS_PROVISION_OPERATION.AMBIGUOUS
  );
  assert.equal(db.row.recoveryNextAttemptAt, null);
  assert.ok(db.row.recoveryExhaustedAt instanceof Date);
});

test("only explicitly safe failures back off while unknown and timeout failures are quarantined", async () => {
  assert.equal(
    classifyGuestAccessProviderFailure(
      new Error("GUEST_ACCESS_PROVISION_SAFE_TO_RETRY:INVALID_WINDOW")
    ),
    "RETRYABLE"
  );
  assert.equal(
    classifyGuestAccessProviderFailure(new Error("INVALID_WINDOW")),
    "AMBIGUOUS"
  );
  assert.equal(
    classifyGuestAccessProviderFailure(new Error("ETIMEDOUT")),
    "AMBIGUOUS"
  );

  const retryDb = new MemoryFenceDb(pendingGrant()).init();
  const retryClaim = await claimGuestAccessProvisioning(retryDb, {
    accessGrantId: "grant-1",
    reservationId: "reservation-1",
    ownerId: "replica-a",
    now: NOW,
  });
  assert.equal(retryClaim.claimed, true);
  if (!retryClaim.claimed) return;
  await beginGuestAccessProvisioningExecution(retryDb, {
    claim: retryClaim.claim,
    now: NOW,
  });
  const retry = await completeGuestAccessProvisioningFailure(retryDb, {
    claim: retryClaim.claim,
    error: new Error(
      "GUEST_ACCESS_PROVISION_SAFE_TO_RETRY:INVALID_WINDOW"
    ),
    now: NOW,
  });
  assert.equal(retry.state, "RETRYABLE");
  assert.ok(retry.nextAttemptAt);

  const ambiguousDb = new MemoryFenceDb(pendingGrant()).init();
  const ambiguousClaim = await claimGuestAccessProvisioning(ambiguousDb, {
    accessGrantId: "grant-1",
    reservationId: "reservation-1",
    ownerId: "replica-b",
    now: NOW,
  });
  assert.equal(ambiguousClaim.claimed, true);
  if (!ambiguousClaim.claimed) return;
  await beginGuestAccessProvisioningExecution(ambiguousDb, {
    claim: ambiguousClaim.claim,
    now: NOW,
  });
  const ambiguous = await completeGuestAccessProvisioningFailure(ambiguousDb, {
    claim: ambiguousClaim.claim,
    error: new Error("provider request ETIMEDOUT token=secret-value"),
    now: NOW,
  });
  assert.equal(ambiguous.state, "AMBIGUOUS");
  assert.equal(ambiguousDb.row.recoveryNextAttemptAt, null);
  assert.equal(String(ambiguousDb.row.lastError).includes("secret-value"), false);
});

test("explicitly safe failure at the final attempt exhausts without ambiguity", async () => {
  const db = new MemoryFenceDb(
    pendingGrant({ recoveryAttemptCount: 6 })
  ).init();
  const claimed = await claimGuestAccessProvisioning(db, {
    accessGrantId: "grant-1",
    reservationId: "reservation-1",
    ownerId: "replica-a",
    now: NOW,
  });
  assert.equal(claimed.claimed, true);
  if (!claimed.claimed) return;
  assert.equal(claimed.claim.attemptCount, 7);

  await beginGuestAccessProvisioningExecution(db, {
    claim: claimed.claim,
    now: NOW,
  });
  const result = await completeGuestAccessProvisioningFailure(db, {
    claim: claimed.claim,
    error: new Error(
      "GUEST_ACCESS_PROVISION_SAFE_TO_RETRY:DETERMINISTIC_PROVIDER_REJECTION"
    ),
    now: NOW,
  });

  assert.equal(result.state, "EXHAUSTED");
  assert.equal(
    db.row.recoveryOperation,
    GUEST_ACCESS_PROVISION_OPERATION.EXHAUSTED
  );
});

test("boundary timeout quarantines execution and does not permit replay", async () => {
  const db = new MemoryFenceDb(pendingGrant()).init();
  const result =
    await executeGuestAccessProvisioningWithFence(db, {
      accessGrantId: "grant-1",
      reservationId: "reservation-1",
      ownerId: "replica-a",
      now: NOW,
      physicalTimeoutMs: 5,
      evaluateReadiness: async () => ({ ready: true }),
      executePhysical: () => new Promise(() => {}),
    });

  assert.equal(result.status, "AMBIGUOUS");
  assert.equal(
    db.row.recoveryOperation,
    GUEST_ACCESS_PROVISION_OPERATION.AMBIGUOUS
  );
  assert.equal(db.row.recoveryNextAttemptAt, null);

  const secondClaim = await claimGuestAccessProvisioning(db, {
    accessGrantId: "grant-1",
    reservationId: "reservation-1",
    ownerId: "replica-b",
    now: new Date(NOW.getTime() + 60_000),
  });
  assert.equal(secondClaim.claimed, false);
  if (!secondClaim.claimed) {
    assert.equal(secondClaim.reason, "AMBIGUOUS");
  }
});

test("a physical callback completing after timeout is reconciled from durable ACTIVE evidence", async () => {
  const db = new MemoryFenceDb(pendingGrant()).init();

  const result = await executeGuestAccessProvisioningWithFence(db, {
    accessGrantId: "grant-1",
    reservationId: "reservation-1",
    ownerId: "replica-a",
    now: NOW,
    physicalTimeoutMs: 5,
    evaluateReadiness: async () => ({ ready: true }),
    executePhysical: async () => {
      await new Promise((resolve) => setTimeout(resolve, 15));
      db.row.status = "ACTIVE";
      db.row.ttlockKeyboardPwdId = 991;
      db.row.secureAccessCode = { id: "code-late" };
      return { ok: true };
    },
  });

  assert.equal(result.status, "AMBIGUOUS");
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(db.row.status, "ACTIVE");
  assert.equal(
    db.row.recoveryOperation,
    GUEST_ACCESS_PROVISION_OPERATION.AMBIGUOUS
  );

  const recovery =
    await recoverStaleGuestAccessProvisioningFences(
      db,
      { now: new Date(NOW.getTime() + 60_000) }
    );

  assert.equal(recovery.reconciledSuccess, 1);
  assert.equal(db.row.recoveryOperation, null);
  assert.equal(db.row.recoveryAttemptCount, 0);
});

test("successful activation clears the provisioning fence", async () => {
  const db = new MemoryFenceDb(pendingGrant()).init();
  const claimed = await claimGuestAccessProvisioning(db, {
    accessGrantId: "grant-1",
    reservationId: "reservation-1",
    ownerId: "replica-a",
    now: NOW,
  });
  assert.equal(claimed.claimed, true);
  if (!claimed.claimed) return;
  await beginGuestAccessProvisioningExecution(db, {
    claim: claimed.claim,
    now: NOW,
  });
  db.row.status = "ACTIVE";
  db.row.ttlockKeyboardPwdId = 444;
  db.row.secureAccessCode = { id: "code-444" };

  const result = await completeGuestAccessProvisioningSuccess(db, {
    claim: claimed.claim,
  });

  assert.equal(result.completed, true);
  assert.equal(db.row.recoveryOperation, null);
  assert.equal(db.row.recoveryAttemptCount, 0);
});

test("a successful callback without durable credential evidence is quarantined", async () => {
  const db = new MemoryFenceDb(pendingGrant()).init();

  const result = await executeGuestAccessProvisioningWithFence(db, {
    accessGrantId: "grant-1",
    reservationId: "reservation-1",
    ownerId: "replica-a",
    now: NOW,
    evaluateReadiness: async () => ({ ready: true }),
    executePhysical: async () => {
      db.row.status = "ACTIVE";
      return { ok: true };
    },
  });

  assert.equal(result.status, "AMBIGUOUS");
  assert.equal(
    db.row.recoveryOperation,
    GUEST_ACCESS_PROVISION_OPERATION.AMBIGUOUS
  );
  assert.match(
    String(db.row.lastError),
    /DURABLE_SUCCESS_EVIDENCE_INCOMPLETE/
  );
});

test("a successful callback with complete durable evidence returns SUCCEEDED", async () => {
  const db = new MemoryFenceDb(pendingGrant()).init();

  const result = await executeGuestAccessProvisioningWithFence(db, {
    accessGrantId: "grant-1",
    reservationId: "reservation-1",
    ownerId: "replica-a",
    now: NOW,
    evaluateReadiness: async () => ({ ready: true }),
    executePhysical: async () => {
      db.row.status = "ACTIVE";
      db.row.ttlockKeyboardPwdId = 445;
      db.row.secureAccessCode = { id: "code-445" };
      return { ok: true };
    },
  });

  assert.equal(result.status, "SUCCEEDED");
  if (result.status === "SUCCEEDED") {
    assert.equal(result.fenceCleared, true);
  }
  assert.equal(db.row.recoveryOperation, null);
  assert.equal(db.row.recoveryAttemptCount, 0);
});

test("claimable query shape permits only idle or due retryable work", () => {
  const where = guestAccessProvisionClaimableWhere(NOW);
  assert.equal(where.OR.length, 2);
  assert.equal(where.OR[0].recoveryOperation, null);
  assert.equal(
    where.OR[1].recoveryOperation,
    GUEST_ACCESS_PROVISION_OPERATION.RETRYABLE
  );
});
