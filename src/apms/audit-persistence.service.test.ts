import assert from "node:assert/strict";
import test from "node:test";

import type { AuditEntry } from "./audit-types.js";
import {
  APMS_AUDIT_DECISION_ID_CONFLICT,
  ApmsAuditDecisionIdConflictError,
  persistAuditEntry,
} from "./audit-persistence.service.js";

const STARTED_AT = new Date("2026-08-04T04:00:00.000Z");
const COMPLETED_AT = new Date("2026-08-04T04:00:01.250Z");

function buildAuditEntry(
  overrides: Partial<AuditEntry> = {}
): AuditEntry {
  return {
    engine: "ACCESS",
    decisionId: "access:reservation-1:attempt-1",
    entityType: "ACCESS",
    entityId: "reservation-1",
    eventType: "ACTION_COMPLETED",
    status: "SUCCESS",
    severity: "INFO",
    summary: "Guest access created",
    startedAt: STARTED_AT,
    completedAt: COMPLETED_AT,
    durationMs: 1250,
    reason: "Credential provisioned successfully",
    decisions: [
      {
        engine: "ACCESS",
        rule: "CREATE_GUEST_ACCESS",
        label: "Create guest access",
        applied: true,
        metadata: {
          provider: "TTLOCK",
          attempts: 1,
        },
      },
    ],
    recommendedAction: "NONE",
    metadata: {
      organizationId: "org-1",
      propertyId: "property-1",
      reservationId: "reservation-1",
      correlationId: "correlation-1",
    },
    ...overrides,
  };
}

function buildPersistedRecord(input: AuditEntry) {
  return {
    id: "audit-1",
    organizationId: input.metadata?.organizationId as string,
    propertyId: input.metadata?.propertyId as string,
    reservationId: input.metadata?.reservationId as string,
    entityType: input.entityType ?? "SYSTEM",
    entityId: input.entityId ?? input.decisionId,
    engine: input.engine,
    eventType: input.eventType ?? null,
    status: input.status,
    severity: input.severity ?? null,
    decisionId: input.decisionId,
    summary: input.summary ?? null,
    reason: input.reason ?? null,
    decisions: input.decisions ?? null,
    recommendedAction: input.recommendedAction ?? null,
    metadata: input.metadata ?? null,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    durationMs: input.durationMs,
    createdAt: new Date("2026-08-04T04:00:02.000Z"),
  };
}

type AuditPersistenceClient = Parameters<
  typeof persistAuditEntry
>[0];

test("creates immutable audit evidence when decisionId is new", async () => {
  const input = buildAuditEntry();
  const created = buildPersistedRecord(input);
  let findUniqueCalls = 0;
  let createCalls = 0;

  const prisma = {
    apmsAuditEntry: {
      async findUnique(args: unknown) {
        findUniqueCalls += 1;
        assert.deepEqual(args, {
          where: { decisionId: input.decisionId },
        });
        return null;
      },
      async create(args: { data: Record<string, unknown> }) {
        createCalls += 1;
        assert.equal(args.data.decisionId, input.decisionId);
        assert.equal(args.data.engine, input.engine);
        assert.equal(args.data.status, input.status);
        assert.equal(args.data.organizationId, "org-1");
        return created;
      },
      async upsert() {
        assert.fail("Immutable audit persistence must not call upsert");
      },
      async update() {
        assert.fail("Immutable audit persistence must not call update");
      },
    },
  } as unknown as AuditPersistenceClient;

  const result = await persistAuditEntry(prisma, input);

  assert.equal(result, created);
  assert.equal(findUniqueCalls, 1);
  assert.equal(createCalls, 1);
});

test("returns existing evidence for an identical duplicate", async () => {
  const input = buildAuditEntry();
  const existing = buildPersistedRecord(input);
  let createCalls = 0;

  const prisma = {
    apmsAuditEntry: {
      async findUnique() {
        return existing;
      },
      async create() {
        createCalls += 1;
        assert.fail(
          "Identical audit evidence must not create another record"
        );
      },
      async upsert() {
        assert.fail("Immutable audit persistence must not call upsert");
      },
      async update() {
        assert.fail("Immutable audit persistence must not call update");
      },
    },
  } as unknown as AuditPersistenceClient;

  const result = await persistAuditEntry(prisma, input);

  assert.equal(result, existing);
  assert.equal(createCalls, 0);
});

test("rejects conflicting evidence for an existing decisionId", async () => {
  const original = buildAuditEntry();
  const conflicting = buildAuditEntry({
    status: "FAILED",
    severity: "CRITICAL",
    summary: "Guest access failed",
  });
  const existing = buildPersistedRecord(original);
  let createCalls = 0;

  const prisma = {
    apmsAuditEntry: {
      async findUnique() {
        return existing;
      },
      async create() {
        createCalls += 1;
        assert.fail(
          "Conflicting audit evidence must not create another record"
        );
      },
      async upsert() {
        assert.fail("Immutable audit persistence must not call upsert");
      },
      async update() {
        assert.fail("Immutable audit persistence must not call update");
      },
    },
  } as unknown as AuditPersistenceClient;

  await assert.rejects(
    () => persistAuditEntry(prisma, conflicting),
    (error: unknown) => {
      assert.ok(error instanceof ApmsAuditDecisionIdConflictError);
      assert.equal(
        error.code,
        APMS_AUDIT_DECISION_ID_CONFLICT
      );
      assert.equal(error.decisionId, original.decisionId);
      return true;
    }
  );

  assert.equal(createCalls, 0);
});

test("accepts a real retry only when it has a distinct decisionId", async () => {
  const retry = buildAuditEntry({
    decisionId: "access:reservation-1:attempt-2",
    status: "SUCCESS",
    summary: "Guest access created after retry",
    metadata: {
      organizationId: "org-1",
      propertyId: "property-1",
      reservationId: "reservation-1",
      correlationId: "correlation-1",
      attempt: 2,
    },
  });
  const created = buildPersistedRecord(retry);
  let createCalls = 0;

  const prisma = {
    apmsAuditEntry: {
      async findUnique() {
        return null;
      },
      async create(args: { data: Record<string, unknown> }) {
        createCalls += 1;
        assert.equal(
          args.data.decisionId,
          "access:reservation-1:attempt-2"
        );
        return created;
      },
      async upsert() {
        assert.fail("Immutable audit persistence must not call upsert");
      },
      async update() {
        assert.fail("Immutable audit persistence must not call update");
      },
    },
  } as unknown as AuditPersistenceClient;

  const result = await persistAuditEntry(prisma, retry);

  assert.equal(result, created);
  assert.equal(createCalls, 1);
});
