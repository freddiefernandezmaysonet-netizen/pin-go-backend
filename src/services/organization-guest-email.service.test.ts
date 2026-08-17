import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import type { PrismaClient } from "@prisma/client";
import { resolveOrganizationGuestReplyTo } from "./organization-guest-email.service.js";

function prismaStub(input: {
  organization: { dashboardUsers: Array<{ email: string }> } | null;
  onQuery?: (query: unknown) => void;
  activeOrganizationUser?: { email: string } | null;
  onActiveUserQuery?: (query: unknown) => void;
}) {
  return {
    organization: {
      findUnique: async (query: unknown) => {
        input.onQuery?.(query);
        return input.organization;
      },
    },
    dashboardUser: {
      findFirst: async (query: unknown) => {
        input.onActiveUserQuery?.(query);
        return input.activeOrganizationUser ?? null;
      },
    },
  } as unknown as PrismaClient;
}

test("guest contact uses the first active organization administrator", async () => {
  let query: unknown;
  const result = await resolveOrganizationGuestReplyTo(
    prismaStub({
      organization: {
        dashboardUsers: [{ email: "OWNER@EXAMPLE.COM" }],
      },
      onQuery: (value) => {
        query = value;
      },
    }),
    "organization-1"
  );

  assert.deepEqual(result, {
    email: "owner@example.com",
    source: "PRIMARY_ADMIN",
  });
  assert.deepEqual(query, {
    where: { id: "organization-1" },
    select: {
      dashboardUsers: {
        where: {
          isActive: true,
          role: { in: ["ORG_ADMIN", "ADMIN"] },
        },
        orderBy: { createdAt: "asc" },
        take: 1,
        select: { email: true },
      },
    },
  });
});

test("guest contact uses the first active organization user when no administrator exists", async () => {
  let query: unknown;
  const result = await resolveOrganizationGuestReplyTo(
    prismaStub({
      organization: { dashboardUsers: [] },
      activeOrganizationUser: {
        email: "PERSONAL@EXAMPLE.COM",
      },
      onActiveUserQuery: (value) => {
        query = value;
      },
    }),
    "organization-1"
  );

  assert.deepEqual(result, {
    email: "personal@example.com",
    source: "ACTIVE_ORGANIZATION_USER",
  });
  assert.deepEqual(query, {
    where: {
      organizationId: "organization-1",
      isActive: true,
    },
    orderBy: { createdAt: "asc" },
    select: { email: true },
  });
});

test("guest contact safely falls back when no active organization user exists", async () => {
  const result = await resolveOrganizationGuestReplyTo(
    prismaStub({
      organization: { dashboardUsers: [] },
      activeOrganizationUser: null,
    }),
    "organization-1"
  );

  assert.deepEqual(result, {
    email: "support@pin-ngo.com",
    source: "PIN_GO_SUPPORT",
  });
});

test("guest contact fails closed for missing organizations and identifiers", async () => {
  await assert.rejects(
    resolveOrganizationGuestReplyTo(
      prismaStub({ organization: null }),
      "organization-1"
    ),
    /GUEST_REPLY_TO_ORGANIZATION_NOT_FOUND/
  );

  let queried = false;
  await assert.rejects(
    resolveOrganizationGuestReplyTo(
      prismaStub({
        organization: null,
        onQuery: () => {
          queried = true;
        },
      }),
      "   "
    ),
    /GUEST_REPLY_TO_ORGANIZATION_ID_REQUIRED/
  );
  assert.equal(queried, false);
});

test("public property response exposes only the resolved contact email", async () => {
  const source = await readFile(
    new URL("../routes/public-booking.routes.ts", import.meta.url),
    "utf8"
  );

  assert.match(
    source,
    /resolveOrganizationGuestReplyTo\(\s*prisma,\s*property\.organizationId\s*\)/
  );
  assert.match(
    source,
    /organization:\s*\{\s*\.\.\.property\.organization,\s*contactEmail:\s*organizationContact\.email/
  );
  assert.doesNotMatch(source, /contactEmail:\s*organizationContact\.source/);
});
