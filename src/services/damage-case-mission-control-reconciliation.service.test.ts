import assert from "node:assert/strict";
import test from "node:test";

import type { PrismaClient } from "@prisma/client";

import { reconcileDamageCaseMissionControl } from "./damage-case-mission-control-reconciliation.service.js";

const prisma = {} as PrismaClient;

test("reconciles one bounded candidate set through the canonical projector", async () => {
  const calls: string[] = [];

  const result = await reconcileDamageCaseMissionControl({
    prisma,
    batchSize: 20,
    maxMessageRetries: 3,
    findCandidates: async (_prisma, batchSize) => {
      assert.equal(_prisma, prisma);
      assert.equal(batchSize, 20);
      return [
        { damageCaseId: "damage-case-1" },
        { damageCaseId: "damage-case-2" },
      ];
    },
    syncDamageCase: async (input) => {
      assert.equal(input.prisma, prisma);
      assert.equal(input.maxMessageRetries, 3);
      calls.push(input.damageCaseId);
      return input.damageCaseId === "damage-case-1"
        ? ({ ok: true, operationalIssue: {} } as never)
        : ({ ok: false, code: "DAMAGE_CASE_NOT_FOUND" } as const);
    },
  });

  assert.deepEqual(calls, ["damage-case-1", "damage-case-2"]);
  assert.deepEqual(result, {
    checked: 2,
    reconciled: 1,
    failed: 1,
  });
});

test("does no writes when no Damage Case projection is stale", async () => {
  let syncCalls = 0;

  const result = await reconcileDamageCaseMissionControl({
    prisma,
    batchSize: 20,
    findCandidates: async () => [],
    syncDamageCase: async () => {
      syncCalls += 1;
      return { ok: false, code: "DAMAGE_CASE_NOT_FOUND" } as const;
    },
  });

  assert.equal(syncCalls, 0);
  assert.deepEqual(result, { checked: 0, reconciled: 0, failed: 0 });
});
