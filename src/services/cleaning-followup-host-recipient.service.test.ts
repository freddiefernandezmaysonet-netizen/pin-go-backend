import assert from "node:assert/strict";
import test from "node:test";

import { DashboardUserRole } from "@prisma/client";
import { resolveCleaningHostAttentionRecipients } from "./cleaning-followup-host-recipient.service.js";

test("prefers active ORG_ADMIN recipients", async () => {
  const calls: any[] = [];
  const prisma: any = {
    dashboardUser: {
      findMany: async ({ where }: any) => {
        calls.push(where);
        if (where.role === DashboardUserRole.ORG_ADMIN) {
          return [
            { email: " OWNER@EXAMPLE.COM " },
            { email: "owner@example.com" },
          ];
        }
        throw new Error("fallback should not run");
      },
    },
  };

  assert.deepEqual(
    await resolveCleaningHostAttentionRecipients(prisma, "org_1"),
    ["owner@example.com"],
  );
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    organizationId: "org_1",
    isActive: true,
    role: DashboardUserRole.ORG_ADMIN,
  });
});

test("uses active ADMIN when no ORG_ADMIN exists", async () => {
  const prisma: any = {
    dashboardUser: {
      findMany: async ({ where }: any) => {
        if (where.role === DashboardUserRole.ORG_ADMIN) return [];
        if (where.role === DashboardUserRole.ADMIN) {
          return [{ email: "admin@example.com" }];
        }
        throw new Error("active-user fallback should not run");
      },
    },
  };

  assert.deepEqual(
    await resolveCleaningHostAttentionRecipients(prisma, "org_1"),
    ["admin@example.com"],
  );
});

test("falls back to active users in the same organization", async () => {
  const calls: any[] = [];
  const prisma: any = {
    dashboardUser: {
      findMany: async ({ where }: any) => {
        calls.push(where);
        if (where.role) return [];
        return [
          { email: "member@example.com" },
          { email: " MEMBER@example.com " },
          { email: "" },
        ];
      },
    },
  };

  assert.deepEqual(
    await resolveCleaningHostAttentionRecipients(prisma, "org_1"),
    ["member@example.com"],
  );
  assert.equal(calls.every((where) => where.organizationId === "org_1"), true);
  assert.deepEqual(calls.at(-1), {
    organizationId: "org_1",
    isActive: true,
  });
});

test("never falls back outside the organization", async () => {
  const calls: any[] = [];
  const prisma: any = {
    dashboardUser: {
      findMany: async ({ where }: any) => {
        calls.push(where);
        return [];
      },
    },
  };

  assert.deepEqual(
    await resolveCleaningHostAttentionRecipients(prisma, "org_1"),
    [],
  );
  assert.equal(calls.every((where) => where.organizationId === "org_1"), true);
});

test("rejects a blank organization id", async () => {
  const prisma: any = {
    dashboardUser: {
      findMany: async () => {
        throw new Error("query should not run");
      },
    },
  };

  await assert.rejects(
    () => resolveCleaningHostAttentionRecipients(prisma, "   "),
    /CLEANING_HOST_ATTENTION_ORG_REQUIRED/,
  );
});
