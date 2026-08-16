import assert from "node:assert/strict";
import test from "node:test";
import {
  approveBrandRevision,
  BrandReviewServiceError,
  rejectBrandRevision,
  submitBrandRevisionForApproval,
  type BrandReviewServiceOptions,
} from "./brand-review.service.js";
import { BrandPolicyError } from "./brand-policy.js";

type ServiceDb = NonNullable<BrandReviewServiceOptions["db"]>;

const PROFILE = {
  id: "brand-profile-a",
  organizationId: "organization-a",
  experienceType: "ENTERPRISE_BRANDED",
  status: "DRAFT",
};

const DRAFT_REVISION = {
  id: "brand-revision-a",
  brandProfileId: "brand-profile-a",
  version: 1,
  approvalStatus: "DRAFT",
};

const PENDING_REVISION = {
  ...DRAFT_REVISION,
  approvalStatus: "PENDING_APPROVAL",
};

type MockInput = {
  actor?: unknown;
  profile?: unknown;
  revision?: unknown;
};

function mockBrandReviewDb(input: MockInput = {}) {
  const calls = {
    transactions: 0,
    actorFindUnique: [] as unknown[],
    profileFindUnique: [] as unknown[],
    revisionFindUnique: [] as unknown[],
    revisionUpdate: [] as unknown[],
  };

  const transaction = {
    dashboardUser: {
      findUnique: async (args: unknown) => {
        calls.actorFindUnique.push(args);
        return input.actor === undefined
          ? {
              id: "platform-admin-a",
              organizationId: "pin-go-organization",
              role: "PLATFORM_ADMIN",
              isActive: true,
            }
          : input.actor;
      },
    },
    brandProfile: {
      findUnique: async (args: unknown) => {
        calls.profileFindUnique.push(args);
        return input.profile === undefined ? PROFILE : input.profile;
      },
    },
    brandRevision: {
      findUnique: async (args: unknown) => {
        calls.revisionFindUnique.push(args);
        return input.revision === undefined
          ? DRAFT_REVISION
          : input.revision;
      },
      update: async (args: { data: Record<string, unknown> }) => {
        calls.revisionUpdate.push(args);
        return {
          ...DRAFT_REVISION,
          ...args.data,
        };
      },
    },
  };

  const db = {
    $transaction: async (
      operation: (tx: typeof transaction) => Promise<unknown>
    ) => {
      calls.transactions += 1;
      return operation(transaction);
    },
  } as unknown as ServiceDb;

  return { db, calls };
}

function assertServiceError(
  error: unknown,
  code: BrandReviewServiceError["code"]
): boolean {
  assert.ok(error instanceof BrandReviewServiceError);
  assert.equal(error.code, code);
  return true;
}

function assertPolicyError(
  error: unknown,
  code: BrandPolicyError["code"]
): boolean {
  assert.ok(error instanceof BrandPolicyError);
  assert.equal(error.code, code);
  return true;
}

test("PLATFORM_ADMIN submits a draft revision for organization approval", async () => {
  const { db, calls } = mockBrandReviewDb();

  const result = await submitBrandRevisionForApproval(
    {
      actor: { userId: "platform-admin-a" },
      brandProfileId: "brand-profile-a",
      brandRevisionId: "brand-revision-a",
    },
    { db }
  );

  assert.equal(calls.transactions, 1);
  assert.equal(calls.revisionUpdate.length, 1);
  const update = calls.revisionUpdate[0] as {
    data: Record<string, unknown>;
  };
  assert.deepEqual(update.data, { approvalStatus: "PENDING_APPROVAL" });
  assert.equal(result.approvalStatus, "PENDING_APPROVAL");
});

test("organization roles cannot submit revisions", async () => {
  const { db, calls } = mockBrandReviewDb({
    actor: {
      id: "org-admin-a",
      organizationId: "organization-a",
      role: "ORG_ADMIN",
      isActive: true,
    },
  });

  await assert.rejects(
    submitBrandRevisionForApproval(
      {
        actor: { userId: "org-admin-a" },
        brandProfileId: "brand-profile-a",
        brandRevisionId: "brand-revision-a",
      },
      { db }
    ),
    (error) => assertPolicyError(error, "BRAND_MANAGER_REQUIRED")
  );
  assert.equal(calls.revisionUpdate.length, 0);
});

test("ORG_ADMIN from the branded organization can approve", async () => {
  const approvedAt = new Date("2026-08-15T21:00:00.000Z");
  const { db, calls } = mockBrandReviewDb({
    actor: {
      id: "org-admin-a",
      organizationId: "organization-a",
      role: "ORG_ADMIN",
      isActive: true,
    },
    revision: PENDING_REVISION,
  });

  const result = await approveBrandRevision(
    {
      actor: { userId: "org-admin-a" },
      brandProfileId: "brand-profile-a",
      brandRevisionId: "brand-revision-a",
    },
    { db, now: () => approvedAt }
  );

  const update = calls.revisionUpdate[0] as {
    data: Record<string, unknown>;
  };
  assert.deepEqual(update.data, {
    approvalStatus: "APPROVED",
    approvedByUserId: "org-admin-a",
    approvedAt,
    rejectedByUserId: null,
    rejectedAt: null,
    rejectionReason: null,
  });
  assert.equal(result.approvalStatus, "APPROVED");
});

test("ADMIN from the branded organization can approve", async () => {
  const { db } = mockBrandReviewDb({
    actor: {
      id: "admin-a",
      organizationId: "organization-a",
      role: "ADMIN",
      isActive: true,
    },
    revision: PENDING_REVISION,
  });

  const result = await approveBrandRevision(
    {
      actor: { userId: "admin-a" },
      brandProfileId: "brand-profile-a",
      brandRevisionId: "brand-revision-a",
    },
    { db }
  );

  assert.equal(result.approvalStatus, "APPROVED");
  assert.equal(result.approvedByUserId, "admin-a");
});

test("PLATFORM_ADMIN cannot approve the revision it configured", async () => {
  const { db, calls } = mockBrandReviewDb({
    revision: PENDING_REVISION,
  });

  await assert.rejects(
    approveBrandRevision(
      {
        actor: { userId: "platform-admin-a" },
        brandProfileId: "brand-profile-a",
        brandRevisionId: "brand-revision-a",
      },
      { db }
    ),
    (error) => assertPolicyError(error, "BRAND_REVIEWER_REQUIRED")
  );
  assert.equal(calls.revisionUpdate.length, 0);
});

test("reviewer from another organization is isolated", async () => {
  const { db, calls } = mockBrandReviewDb({
    actor: {
      id: "org-admin-b",
      organizationId: "organization-b",
      role: "ORG_ADMIN",
      isActive: true,
    },
    revision: PENDING_REVISION,
  });

  await assert.rejects(
    approveBrandRevision(
      {
        actor: { userId: "org-admin-b" },
        brandProfileId: "brand-profile-a",
        brandRevisionId: "brand-revision-a",
      },
      { db }
    ),
    (error) =>
      assertPolicyError(error, "BRAND_REVIEW_ORGANIZATION_MISMATCH")
  );
  assert.equal(calls.revisionUpdate.length, 0);
});

test("rejection records reviewer, timestamp and normalized reason", async () => {
  const rejectedAt = new Date("2026-08-15T22:00:00.000Z");
  const { db, calls } = mockBrandReviewDb({
    actor: {
      id: "org-admin-a",
      organizationId: "organization-a",
      role: "ORG_ADMIN",
      isActive: true,
    },
    revision: PENDING_REVISION,
  });

  const result = await rejectBrandRevision(
    {
      actor: { userId: "org-admin-a" },
      brandProfileId: "brand-profile-a",
      brandRevisionId: "brand-revision-a",
      rejectionReason: "  Please replace the low-resolution logo.  ",
    },
    { db, now: () => rejectedAt }
  );

  const update = calls.revisionUpdate[0] as {
    data: Record<string, unknown>;
  };
  assert.deepEqual(update.data, {
    approvalStatus: "REJECTED",
    rejectedByUserId: "org-admin-a",
    rejectedAt,
    rejectionReason: "Please replace the low-resolution logo.",
    approvedByUserId: null,
    approvedAt: null,
  });
  assert.equal(result.approvalStatus, "REJECTED");
});

test("invalid rejection reason fails before opening a transaction", async () => {
  const { db, calls } = mockBrandReviewDb({
    actor: {
      id: "org-admin-a",
      organizationId: "organization-a",
      role: "ORG_ADMIN",
      isActive: true,
    },
    revision: PENDING_REVISION,
  });

  await assert.rejects(
    rejectBrandRevision(
      {
        actor: { userId: "org-admin-a" },
        brandProfileId: "brand-profile-a",
        brandRevisionId: "brand-revision-a",
        rejectionReason: " ",
      },
      { db }
    ),
    (error) =>
      assertServiceError(error, "BRAND_REVIEW_REJECTION_REASON_INVALID")
  );
  assert.equal(calls.transactions, 0);
});

test("inactive or missing actor cannot participate", async () => {
  const cases = [
    {
      actor: null,
      code: "BRAND_REVIEW_ACTOR_NOT_FOUND",
    },
    {
      actor: {
        id: "org-admin-a",
        organizationId: "organization-a",
        role: "ORG_ADMIN",
        isActive: false,
      },
      code: "BRAND_REVIEW_ACTOR_INACTIVE",
    },
  ] as const;

  for (const item of cases) {
    const { db, calls } = mockBrandReviewDb({
      actor: item.actor,
      revision: PENDING_REVISION,
    });
    await assert.rejects(
      approveBrandRevision(
        {
          actor: { userId: "org-admin-a" },
          brandProfileId: "brand-profile-a",
          brandRevisionId: "brand-revision-a",
        },
        { db }
      ),
      (error) => assertServiceError(error, item.code)
    );
    assert.equal(calls.revisionUpdate.length, 0);
  }
});

test("revision from another profile cannot be reviewed", async () => {
  const { db, calls } = mockBrandReviewDb({
    actor: {
      id: "org-admin-a",
      organizationId: "organization-a",
      role: "ORG_ADMIN",
      isActive: true,
    },
    revision: {
      ...PENDING_REVISION,
      brandProfileId: "brand-profile-b",
    },
  });

  await assert.rejects(
    approveBrandRevision(
      {
        actor: { userId: "org-admin-a" },
        brandProfileId: "brand-profile-a",
        brandRevisionId: "brand-revision-a",
      },
      { db }
    ),
    (error) =>
      assertServiceError(
        error,
        "BRAND_REVIEW_REVISION_PROFILE_MISMATCH"
      )
  );
  assert.equal(calls.revisionUpdate.length, 0);
});

test("invalid revision state transition never writes", async () => {
  const { db, calls } = mockBrandReviewDb({
    actor: {
      id: "org-admin-a",
      organizationId: "organization-a",
      role: "ORG_ADMIN",
      isActive: true,
    },
    revision: {
      ...DRAFT_REVISION,
      approvalStatus: "DRAFT",
    },
  });

  await assert.rejects(
    approveBrandRevision(
      {
        actor: { userId: "org-admin-a" },
        brandProfileId: "brand-profile-a",
        brandRevisionId: "brand-revision-a",
      },
      { db }
    ),
    (error) =>
      assertPolicyError(error, "BRAND_REVISION_TRANSITION_INVALID")
  );
  assert.equal(calls.revisionUpdate.length, 0);
});

test("standard profile cannot enter enterprise brand review", async () => {
  const { db, calls } = mockBrandReviewDb({
    profile: {
      ...PROFILE,
      experienceType: "STANDARD",
    },
  });

  await assert.rejects(
    submitBrandRevisionForApproval(
      {
        actor: { userId: "platform-admin-a" },
        brandProfileId: "brand-profile-a",
        brandRevisionId: "brand-revision-a",
      },
      { db }
    ),
    (error) =>
      assertServiceError(error, "BRAND_REVIEW_PROFILE_NOT_ENTERPRISE")
  );
  assert.equal(calls.revisionUpdate.length, 0);
});
