import assert from "node:assert/strict";
import test from "node:test";

import {
  executeGuestAccessProvisioningWithFence,
} from "./guest-access-reservation-singleton-fence.e14.js";
import {
  recoverStaleGuestAccessProvisioningFences,
} from "./guest-access-admission-fence.service.e14.js";
import {
  projectGuestAccessAmbiguityIssue,
  type GuestAccessMissionSnapshot,
} from "./guest-access-readiness-mission-control.policy.e14.js";

const NOW = new Date("2026-08-28T12:00:00.000Z");
const CHECK_IN = new Date("2026-08-28T15:00:00.000Z");
const CHECK_OUT = new Date("2026-08-30T11:00:00.000Z");
const RESERVATION_ID = "reservation-1";

function clone<T>(value: T): T {
  return structuredClone(value);
}

function sameValue(left: unknown, right: unknown): boolean {
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
    if (key === "AND") {
      if (!(expected as any[]).every((item) => matchesWhere(row, item))) {
        return false;
      }
      continue;
    }

    if (key === "OR") {
      if (!(expected as any[]).some((item) => matchesWhere(row, item))) {
        return false;
      }
      continue;
    }

    if (key === "reservation") {
      const relationWhere = (expected as any)?.is ?? expected;
      if (!matchesWhere(row.reservation, relationWhere)) return false;
      continue;
    }

    const actual = row?.[key];

    if (
      expected &&
      typeof expected === "object" &&
      !(expected instanceof Date)
    ) {
      const operator = expected as Record<string, any>;

      if ("in" in operator) {
        if (!operator.in.includes(actual)) return false;
        continue;
      }
      if ("not" in operator) {
        if (sameValue(actual, operator.not)) return false;
        continue;
      }
      if ("startsWith" in operator) {
        if (
          typeof actual !== "string" ||
          !actual.startsWith(operator.startsWith)
        ) {
          return false;
        }
        continue;
      }
      if ("gt" in operator) {
        if (
          !(actual instanceof Date) ||
          actual.getTime() <= operator.gt.getTime()
        ) {
          return false;
        }
        continue;
      }
      if ("gte" in operator) {
        if (
          !(actual instanceof Date) ||
          actual.getTime() < operator.gte.getTime()
        ) {
          return false;
        }
        continue;
      }
      if ("lt" in operator) {
        if (
          !(actual instanceof Date) ||
          actual.getTime() >= operator.lt.getTime()
        ) {
          return false;
        }
        continue;
      }
      if ("lte" in operator) {
        if (
          !(actual instanceof Date) ||
          actual.getTime() > operator.lte.getTime()
        ) {
          return false;
        }
        continue;
      }

      if (!matchesWhere(actual, expected)) return false;
      continue;
    }

    if (!sameValue(actual, expected)) return false;
  }

  return true;
}

function pendingGrant(
  id: string,
  overrides: Record<string, any> = {}
) {
  const reservation = {
    id: RESERVATION_ID,
    status: "ACTIVE",
    paymentState: "PAID",
    guestAccessReleaseStatus: "ELIGIBLE",
    checkIn: new Date(CHECK_IN),
    checkOut: new Date(CHECK_OUT),
    ...(overrides.reservation ?? {}),
  };

  const { reservation: _reservation, ...grantOverrides } = overrides;

  return {
    id,
    reservationId: RESERVATION_ID,
    type: "GUEST",
    method: "PASSCODE_TIMEBOUND",
    status: "PENDING",
    startsAt: new Date(CHECK_IN),
    endsAt: new Date(CHECK_OUT),
    recoveryOperation: null,
    recoveryAttemptCount: 0,
    recoveryLastAttemptAt: null,
    recoveryNextAttemptAt: null,
    recoveryExhaustedAt: null,
    lastError: null,
    ttlockKeyboardPwdId: null,
    secureAccessCode: null,
    updatedAt: new Date(NOW),
    reservation,
    ...grantOverrides,
  };
}

class MemoryReservationFenceDb {
  private rows: any[];
  private transactionTail: Promise<void> = Promise.resolve();
  lockCount = 0;

  constructor(rows: any[]) {
    this.rows = clone(rows);
  }

  accessGrant = {
    findUnique: async ({ where }: any) => {
      const row = this.rows.find((item) => item.id === where.id);
      return row ? clone(row) : null;
    },
    findMany: async ({ where, take, orderBy }: any) => {
      let rows = this.rows.filter((row) => matchesWhere(row, where));

      if (orderBy) {
        const [field, direction] = Object.entries(orderBy)[0] as [
          string,
          "asc" | "desc",
        ];
        rows = [...rows].sort((left, right) => {
          const leftValue = left[field];
          const rightValue = right[field];
          const leftTime =
            leftValue instanceof Date ? leftValue.getTime() : 0;
          const rightTime =
            rightValue instanceof Date ? rightValue.getTime() : 0;
          return direction === "asc"
            ? leftTime - rightTime
            : rightTime - leftTime;
        });
      }

      return clone(
        typeof take === "number" ? rows.slice(0, take) : rows
      );
    },
    updateMany: async ({ where, data }: any) => {
      let count = 0;
      for (const row of this.rows) {
        if (!matchesWhere(row, where)) continue;
        Object.assign(row, clone(data), { updatedAt: new Date() });
        count += 1;
      }
      return { count };
    },
  };

  async $transaction<T>(
    operation: (tx: MemoryReservationFenceDb) => Promise<T>
  ): Promise<T> {
    const previous = this.transactionTail;
    let release!: () => void;
    this.transactionTail = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      return await operation(this);
    } finally {
      release();
    }
  }

  async $queryRawUnsafe<T = unknown>(
    query: string,
    ...values: unknown[]
  ): Promise<T> {
    assert.match(query, /FOR UPDATE/);
    this.lockCount += 1;
    const reservationId = String(values[0] ?? "");
    const exists = this.rows.some(
      (row) => row.reservation?.id === reservationId
    );
    return (exists ? [{ id: reservationId }] : []) as T;
  }

  read(id: string) {
    const row = this.rows.find((item) => item.id === id);
    return row ? clone(row) : null;
  }

  mutate(id: string, data: Record<string, unknown>) {
    const row = this.rows.find((item) => item.id === id);
    assert.ok(row, `missing grant ${id}`);
    Object.assign(row, clone(data), { updatedAt: new Date() });
  }
}

function staleSibling(id = "grant-stale") {
  return pendingGrant(id, {
    startsAt: new Date("2026-08-27T15:00:00.000Z"),
    endsAt: new Date("2026-08-29T11:00:00.000Z"),
  });
}

async function runProvisioning(
  db: MemoryReservationFenceDb,
  input: {
    grantId: string;
    ownerId: string;
    executePhysical: () => Promise<{ ok: boolean; passcodePlain?: string }>;
    physicalTimeoutMs?: number;
  }
) {
  return executeGuestAccessProvisioningWithFence(db as any, {
    accessGrantId: input.grantId,
    reservationId: RESERVATION_ID,
    ownerId: input.ownerId,
    now: NOW,
    evaluateReadiness: async () => ({ ready: true }),
    executePhysical: input.executePhysical,
    ...(input.physicalTimeoutMs === undefined
      ? {}
      : { physicalTimeoutMs: input.physicalTimeoutMs }),
  });
}

function completePhysicalGrant(
  db: MemoryReservationFenceDb,
  grantId: string
) {
  db.mutate(grantId, {
    status: "ACTIVE",
    ttlockKeyboardPwdId: 101,
    secureAccessCode: { id: `secure-${grantId}` },
  });
}

function ambiguitySnapshot(
  db: MemoryReservationFenceDb
): GuestAccessMissionSnapshot {
  const grants = ["grant-primary", "grant-stale"]
    .map((id) => db.read(id))
    .filter(Boolean)
    .map((grant: any) => ({
      status: grant.status,
      providerCredentialPresent: Boolean(grant.ttlockKeyboardPwdId),
      secureCodePresent: Boolean(grant.secureAccessCode),
      recoveryOperation: grant.recoveryOperation,
      recoveryNextAttemptAt: grant.recoveryNextAttemptAt,
      recoveryExhaustedAt: grant.recoveryExhaustedAt,
    }));

  return {
    reservationId: RESERVATION_ID,
    reservationNumber: "PG-2026-000100",
    guestName: "Guest",
    organizationId: "org-1",
    propertyId: "property-1",
    status: "ACTIVE",
    guestAccessReleaseStatus: "ELIGIBLE",
    checkIn: new Date(CHECK_IN),
    checkOut: new Date(CHECK_OUT),
    accessGrants: grants,
  };
}

test("one replica claims exactly one canonical grant and calls the provider once", async () => {
  const db = new MemoryReservationFenceDb([
    pendingGrant("grant-primary"),
    staleSibling(),
  ]);
  let callbacks = 0;

  const result = await runProvisioning(db, {
    grantId: "grant-primary",
    ownerId: "replica-a",
    executePhysical: async () => {
      callbacks += 1;
      completePhysicalGrant(db, "grant-primary");
      return { ok: true, passcodePlain: "1234567" };
    },
  });

  assert.equal(result.status, "SUCCEEDED");
  assert.equal(callbacks, 1);
  assert.equal(db.lockCount, 1);
  assert.equal(db.read("grant-primary")?.status, "ACTIVE");
  assert.equal(db.read("grant-primary")?.recoveryOperation, null);
  assert.equal(db.read("grant-stale")?.status, "PENDING");
});

test("two replicas competing for one reservation produce one physical callback", async () => {
  const db = new MemoryReservationFenceDb([
    pendingGrant("grant-primary"),
    staleSibling(),
  ]);
  let callbacks = 0;

  const executePhysical = async () => {
    callbacks += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
    completePhysicalGrant(db, "grant-primary");
    return { ok: true, passcodePlain: "1234567" };
  };

  const results = await Promise.all([
    runProvisioning(db, {
      grantId: "grant-primary",
      ownerId: "replica-a",
      executePhysical,
    }),
    runProvisioning(db, {
      grantId: "grant-primary",
      ownerId: "replica-b",
      executePhysical,
    }),
  ]);

  assert.equal(
    results.filter((result) => result.status === "SUCCEEDED").length,
    1
  );
  assert.equal(callbacks, 1);
  assert.equal(db.lockCount, 2);
});

test("two canonical sibling grants fail closed under one and two replicas", async () => {
  for (const replicaCount of [1, 2]) {
    const db = new MemoryReservationFenceDb([
      pendingGrant("grant-primary"),
      pendingGrant("grant-sibling"),
    ]);
    let callbacks = 0;

    const attempts = Array.from({ length: replicaCount }, (_, index) =>
      runProvisioning(db, {
        grantId: index === 0 ? "grant-primary" : "grant-sibling",
        ownerId: `replica-${index + 1}`,
        executePhysical: async () => {
          callbacks += 1;
          return { ok: true };
        },
      })
    );

    const results = await Promise.all(attempts);
    assert.equal(callbacks, 0);
    assert.equal(
      results.every((result) => result.status !== "SUCCEEDED"),
      true
    );
    assert.equal(
      [db.read("grant-primary"), db.read("grant-sibling")].some(
        (grant) =>
          grant?.recoveryOperation ===
          "GUEST_ACCESS_PROVISION_AMBIGUOUS"
      ),
      true
    );
  }
});

test("CLAIMED EXECUTING RETRYABLE AMBIGUOUS EXHAUSTED and ACTIVE siblings block replay", async () => {
  const states = [
    {
      status: "PENDING",
      recoveryOperation:
        "GUEST_ACCESS_PROVISION_CLAIMED:" + "a".repeat(64),
      recoveryNextAttemptAt: new Date(NOW.getTime() + 60_000),
    },
    {
      status: "PENDING",
      recoveryOperation:
        "GUEST_ACCESS_PROVISION_EXECUTING:" + "b".repeat(64),
      recoveryNextAttemptAt: new Date(NOW.getTime() + 60_000),
    },
    {
      status: "PENDING",
      recoveryOperation: "GUEST_ACCESS_PROVISION_RETRYABLE",
      recoveryNextAttemptAt: new Date(NOW.getTime() + 60_000),
    },
    {
      status: "PENDING",
      recoveryOperation: "GUEST_ACCESS_PROVISION_AMBIGUOUS",
      recoveryExhaustedAt: NOW,
    },
    {
      status: "PENDING",
      recoveryOperation: "GUEST_ACCESS_PROVISION_EXHAUSTED",
      recoveryExhaustedAt: NOW,
    },
    {
      status: "ACTIVE",
      recoveryOperation: null,
      ttlockKeyboardPwdId: 202,
      secureAccessCode: { id: "secure-sibling" },
    },
  ];

  for (const siblingState of states) {
    const db = new MemoryReservationFenceDb([
      pendingGrant("grant-primary"),
      staleSibling("grant-sibling"),
    ]);
    db.mutate("grant-sibling", siblingState);
    let callbacks = 0;

    const result = await runProvisioning(db, {
      grantId: "grant-primary",
      ownerId: "replica-a",
      executePhysical: async () => {
        callbacks += 1;
        return { ok: true };
      },
    });

    assert.notEqual(result.status, "SUCCEEDED");
    assert.equal(callbacks, 0);
  }
});

test("timeout, late completion and sibling replay preserve ambiguity until same-grant reconciliation", async () => {
  const db = new MemoryReservationFenceDb([
    pendingGrant("grant-primary"),
    staleSibling(),
  ]);
  let callbacks = 0;

  const result = await runProvisioning(db, {
    grantId: "grant-primary",
    ownerId: "replica-a",
    physicalTimeoutMs: 5,
    executePhysical: async () => {
      callbacks += 1;
      await new Promise((resolve) => setTimeout(resolve, 25));
      completePhysicalGrant(db, "grant-primary");
      return { ok: true, passcodePlain: "1234567" };
    },
  });

  assert.equal(result.status, "AMBIGUOUS");
  assert.equal(callbacks, 1);

  await new Promise((resolve) => setTimeout(resolve, 35));

  const lateGrant = db.read("grant-primary");
  assert.equal(lateGrant?.status, "ACTIVE");
  assert.equal(
    lateGrant?.recoveryOperation,
    "GUEST_ACCESS_PROVISION_AMBIGUOUS"
  );

  const issueBeforeReconciliation =
    projectGuestAccessAmbiguityIssue(ambiguitySnapshot(db), {
      now: new Date(NOW.getTime() + 60_000),
    });
  assert.equal(issueBeforeReconciliation.active, true);

  let siblingCallbacks = 0;
  const siblingReplay = await runProvisioning(db, {
    grantId: "grant-stale",
    ownerId: "replica-b",
    executePhysical: async () => {
      siblingCallbacks += 1;
      return { ok: true };
    },
  });

  assert.notEqual(siblingReplay.status, "SUCCEEDED");
  assert.equal(siblingCallbacks, 0);

  const recovery = await recoverStaleGuestAccessProvisioningFences(
    db as any,
    { now: new Date(NOW.getTime() + 120_000) }
  );

  assert.equal(recovery.reconciledSuccess, 1);
  assert.equal(db.read("grant-primary")?.recoveryOperation, null);
  assert.equal(db.read("grant-stale")?.recoveryOperation, null);

  const issueAfterReconciliation =
    projectGuestAccessAmbiguityIssue(ambiguitySnapshot(db), {
      now: new Date(NOW.getTime() + 180_000),
    });
  assert.equal(issueAfterReconciliation.active, false);
});
