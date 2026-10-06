import assert from "node:assert/strict";
import test from "node:test";
import type { PrismaClient } from "@prisma/client";
import { resolveDirectBookingHostRecipient } from "./direct-booking-host-recipient.service.js";

const user = (role: string, organizationId = "org-a", isActive = true) => ({
  role, organizationId, isActive, email: `${role.toLowerCase()}@example.com`, fullName: role,
});

function database(users: ReturnType<typeof user>[]) {
  let calls = 0;
  return {
    get calls() { return calls; },
    prisma: { dashboardUser: { findFirst: async ({ where }: any) => {
      calls++;
      assert.ok(where.organizationId, "every lookup must be organization-scoped");
      assert.equal(where.isActive, true);
      return users.find(u => u.organizationId === where.organizationId &&
        u.isActive === where.isActive && u.role === where.role) ?? null;
    } } } as unknown as PrismaClient,
  };
}

test("organization administrator retains priority over legacy and platform admins", async () => {
  const db = database([user("PLATFORM_ADMIN"), user("ADMIN"), user("ORG_ADMIN")]);
  assert.equal((await resolveDirectBookingHostRecipient(db.prisma, "org-a"))?.email, "org_admin@example.com");
  assert.equal(db.calls, 1);
});

test("legacy administrator receives the notification when no organization administrator exists", async () => {
  const db = database([user("PLATFORM_ADMIN"), user("ADMIN")]);
  assert.equal((await resolveDirectBookingHostRecipient(db.prisma, "org-a"))?.email, "admin@example.com");
});

test("platform administrator is eligible in their own organization", async () => {
  const db = database([user("PLATFORM_ADMIN")]);
  assert.equal((await resolveDirectBookingHostRecipient(db.prisma, " org-a "))?.email, "platform_admin@example.com");
});

test("members, inactive admins and admins in other organizations never receive the notification", async () => {
  const db = database([user("MEMBER"), user("ORG_ADMIN", "org-a", false),
    user("ADMIN", "org-b"), user("PLATFORM_ADMIN", "org-b")]);
  assert.equal(await resolveDirectBookingHostRecipient(db.prisma, "org-a"), null);
});

test("missing organization fails before any query", async () => {
  const db = database([user("PLATFORM_ADMIN")]);
  await assert.rejects(resolveDirectBookingHostRecipient(db.prisma, " "), /ORGANIZATION_ID_REQUIRED/);
  assert.equal(db.calls, 0);
});

test("malformed administrator email is not selected", async () => {
  const db = database([{ ...user("ADMIN"), email: "invalid" }, user("PLATFORM_ADMIN")]);
  assert.equal((await resolveDirectBookingHostRecipient(db.prisma, "org-a"))?.email, "platform_admin@example.com");
});
