import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import express from "express";
import type { PrismaClient } from "@prisma/client";
import { buildStaffRouter } from "./staff.routes.js";

// HTTP contract with injected persistence. No provider, database or auth bypass is attached.
test("Staff timing HTTP contract", async t => {
  let saved: Record<string, unknown> = { cleaningDurationCommitmentMinutes: 180,
    cleaningStartConfirmationGraceMinutes: 45, cleaningFollowupGraceMinutes: 20 };
  let lastUpdate: Record<string, unknown> | null = null;
  const tx = {
    property: { async findFirst() { return { id: "property-a" }; } },
    propertyStaff: {
      async findUnique() { return { cleaningDurationCommitmentMinutes: saved.cleaningDurationCommitmentMinutes as number | null, cleaningStartConfirmationGraceMinutes: saved.cleaningStartConfirmationGraceMinutes as number }; },
      async updateMany() { return { count: 0 }; },
      async upsert(args: { update: Record<string, unknown> }) {
        lastUpdate = args.update; saved = { ...saved, ...args.update }; return saved;
      },
    },
  };
  const client = {
    staffMember: { async findUnique() { return { id: "staff-a", organizationId: "org-a" }; } },
    async $transaction(run: (value: typeof tx) => Promise<unknown>) { return run(tx); },
  } as unknown as PrismaClient;
  const app = express();
  app.use(express.json());
  app.use("/staff", buildStaffRouter(client));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  const send = (patch: Record<string, unknown>) => fetch(`http://127.0.0.1:${port}/staff/staff-a/property-assignments`, {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ assignments: [{ propertyId: "property-a", role: "PRIMARY", isActive: true, ...patch }] }),
  });
  try {
    await t.test("legacy form preserves previously stored timings", async () => {
      assert.equal((await send({})).status, 200);
      assert.equal(saved.cleaningDurationCommitmentMinutes, 180);
      assert.equal(saved.cleaningStartConfirmationGraceMinutes, 45);
      assert.equal(saved.cleaningFollowupGraceMinutes, 20);
      assert.equal(Object.hasOwn(lastUpdate!, "cleaningDurationCommitmentMinutes"), false);
    });
    await t.test("partial update changes only the selected timing", async () => {
      assert.equal((await send({ cleaningFollowupGraceMinutes: 25 })).status, 200);
      assert.equal(saved.cleaningFollowupGraceMinutes, 25);
      assert.equal(saved.cleaningDurationCommitmentMinutes, 180);
    });
    await t.test("zero-width start reminder is a controlled HTTP 400", async () => {\n      const before = { ...saved };\n      assert.equal((await send({ cleaningDurationCommitmentMinutes: 30, cleaningStartConfirmationGraceMinutes: 30 })).status, 400);\n      assert.deepEqual(saved, before);\n    });\n    await t.test("decimal timing is a controlled HTTP 400, never truncated or persisted", async () => {
      const before = { ...saved };
      assert.equal((await send({ cleaningDurationCommitmentMinutes: 120.7 })).status, 400);
      assert.deepEqual(saved, before);
    });
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
