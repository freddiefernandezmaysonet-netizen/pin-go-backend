import { prisma } from "../../lib/prisma.js";
import {
  requireBrandManagerRole,
  requireBrandReviewAuthorization,
  requireBrandRevisionTransition,
} from "./brand-policy.js";

export type BrandReviewServiceErrorCode =
  | "BRAND_REVIEW_INPUT_INVALID"
  | "BRAND_REVIEW_ACTOR_NOT_FOUND"
  | "BRAND_REVIEW_ACTOR_INACTIVE"
  | "BRAND_REVIEW_PROFILE_NOT_FOUND"
  | "BRAND_REVIEW_PROFILE_NOT_ENTERPRISE"
  | "BRAND_REVIEW_REVISION_NOT_FOUND"
  | "BRAND_REVIEW_REVISION_PROFILE_MISMATCH"
  | "BRAND_REVIEW_REJECTION_REASON_INVALID";

export class BrandReviewServiceError extends Error {
  constructor(
    readonly code: BrandReviewServiceErrorCode,
    message: string,
    readonly context: Readonly<Record<string, unknown>> = {}
  ) {
    super(`${code}: ${message}`);
    this.name = "BrandReviewServiceError";
  }
}

export type BrandReviewActorInput = {
  userId: string;
};

export type SubmitBrandRevisionForApprovalInput = {
  actor: BrandReviewActorInput;
  brandProfileId: string;
  brandRevisionId: string;
};

export type ApproveBrandRevisionInput = {
  actor: BrandReviewActorInput;
  brandProfileId: string;
  brandRevisionId: string;
};

export type RejectBrandRevisionInput = {
  actor: BrandReviewActorInput;
  brandProfileId: string;
  brandRevisionId: string;
  rejectionReason: string;
};

export type BrandReviewServiceOptions = {
  db?: typeof prisma;
  now?: () => Date;
};

type BrandReviewTransactionClient = Pick<
  typeof prisma,
  "dashboardUser" | "brandProfile" | "brandRevision"
>;

type BrandReviewActorRecord = {
  id: string;
  organizationId: string;
  role: "ADMIN" | "MEMBER" | "PLATFORM_ADMIN" | "ORG_ADMIN";
  isActive: boolean;
};

function reviewTransactionClient(
  transaction: unknown
): BrandReviewTransactionClient {
  return transaction as BrandReviewTransactionClient;
}

function requiredId(
  value: string | null | undefined,
  field: string
): string {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    throw new BrandReviewServiceError(
      "BRAND_REVIEW_INPUT_INVALID",
      `${field} is required.`,
      { field }
    );
  }
  return normalized;
}

async function requireActiveActor(
  tx: BrandReviewTransactionClient,
  rawUserId: string | null | undefined
): Promise<BrandReviewActorRecord> {
  const userId = requiredId(rawUserId, "actor.userId");
  const actor = await tx.dashboardUser.findUnique({
    where: { id: userId },
    select: {
      id: true,
      organizationId: true,
      role: true,
      isActive: true,
    },
  });

  if (!actor) {
    throw new BrandReviewServiceError(
      "BRAND_REVIEW_ACTOR_NOT_FOUND",
      "The brand workflow actor does not exist.",
      { userId }
    );
  }
  if (!actor.isActive) {
    throw new BrandReviewServiceError(
      "BRAND_REVIEW_ACTOR_INACTIVE",
      "The brand workflow actor is inactive.",
      { userId }
    );
  }

  return actor;
}

async function requireEnterpriseProfile(
  tx: BrandReviewTransactionClient,
  rawProfileId: string
) {
  const profileId = requiredId(rawProfileId, "brandProfileId");
  const profile = await tx.brandProfile.findUnique({
    where: { id: profileId },
    select: {
      id: true,
      organizationId: true,
      experienceType: true,
      status: true,
    },
  });

  if (!profile) {
    throw new BrandReviewServiceError(
      "BRAND_REVIEW_PROFILE_NOT_FOUND",
      "The brand profile does not exist.",
      { profileId }
    );
  }
  if (profile.experienceType !== "ENTERPRISE_BRANDED") {
    throw new BrandReviewServiceError(
      "BRAND_REVIEW_PROFILE_NOT_ENTERPRISE",
      "The profile is not configured for enterprise branding.",
      { profileId }
    );
  }

  return profile;
}

async function requireProfileRevision(
  tx: BrandReviewTransactionClient,
  rawRevisionId: string,
  profileId: string
) {
  const revisionId = requiredId(rawRevisionId, "brandRevisionId");
  const revision = await tx.brandRevision.findUnique({
    where: { id: revisionId },
    select: {
      id: true,
      brandProfileId: true,
      version: true,
      approvalStatus: true,
    },
  });

  if (!revision) {
    throw new BrandReviewServiceError(
      "BRAND_REVIEW_REVISION_NOT_FOUND",
      "The brand revision does not exist.",
      { revisionId }
    );
  }
  if (revision.brandProfileId !== profileId) {
    throw new BrandReviewServiceError(
      "BRAND_REVIEW_REVISION_PROFILE_MISMATCH",
      "The revision does not belong to the selected brand profile.",
      {
        revisionId,
        revisionProfileId: revision.brandProfileId,
        profileId,
      }
    );
  }

  return revision;
}

function normalizedRejectionReason(rawReason: string): string {
  const reason = String(rawReason ?? "").trim();
  if (reason.length < 3 || reason.length > 500) {
    throw new BrandReviewServiceError(
      "BRAND_REVIEW_REJECTION_REASON_INVALID",
      "rejectionReason must contain between 3 and 500 characters.",
      { field: "rejectionReason" }
    );
  }
  return reason;
}

export async function submitBrandRevisionForApproval(
  input: SubmitBrandRevisionForApprovalInput,
  options: BrandReviewServiceOptions = {}
) {
  const db = options.db ?? prisma;

  return db.$transaction(
    async (transaction) => {
      const tx = reviewTransactionClient(transaction);
      const actor = await requireActiveActor(tx, input.actor.userId);
      requireBrandManagerRole(actor.role);

      const profile = await requireEnterpriseProfile(
        tx,
        input.brandProfileId
      );
      const revision = await requireProfileRevision(
        tx,
        input.brandRevisionId,
        profile.id
      );
      requireBrandRevisionTransition(
        revision.approvalStatus,
        "PENDING_APPROVAL"
      );

      return tx.brandRevision.update({
        where: { id: revision.id },
        data: {
          approvalStatus: "PENDING_APPROVAL",
        },
      });
    },
    { isolationLevel: "Serializable" }
  );
}

export async function approveBrandRevision(
  input: ApproveBrandRevisionInput,
  options: BrandReviewServiceOptions = {}
) {
  const db = options.db ?? prisma;
  const now = options.now ?? (() => new Date());

  return db.$transaction(
    async (transaction) => {
      const tx = reviewTransactionClient(transaction);
      const actor = await requireActiveActor(tx, input.actor.userId);
      const profile = await requireEnterpriseProfile(
        tx,
        input.brandProfileId
      );
      requireBrandReviewAuthorization({
        role: actor.role,
        actorOrganizationId: actor.organizationId,
        brandOrganizationId: profile.organizationId,
      });

      const revision = await requireProfileRevision(
        tx,
        input.brandRevisionId,
        profile.id
      );
      requireBrandRevisionTransition(revision.approvalStatus, "APPROVED");

      return tx.brandRevision.update({
        where: { id: revision.id },
        data: {
          approvalStatus: "APPROVED",
          approvedByUserId: actor.id,
          approvedAt: now(),
          rejectedByUserId: null,
          rejectedAt: null,
          rejectionReason: null,
        },
      });
    },
    { isolationLevel: "Serializable" }
  );
}

export async function rejectBrandRevision(
  input: RejectBrandRevisionInput,
  options: BrandReviewServiceOptions = {}
) {
  const db = options.db ?? prisma;
  const now = options.now ?? (() => new Date());
  const rejectionReason = normalizedRejectionReason(input.rejectionReason);

  return db.$transaction(
    async (transaction) => {
      const tx = reviewTransactionClient(transaction);
      const actor = await requireActiveActor(tx, input.actor.userId);
      const profile = await requireEnterpriseProfile(
        tx,
        input.brandProfileId
      );
      requireBrandReviewAuthorization({
        role: actor.role,
        actorOrganizationId: actor.organizationId,
        brandOrganizationId: profile.organizationId,
      });

      const revision = await requireProfileRevision(
        tx,
        input.brandRevisionId,
        profile.id
      );
      requireBrandRevisionTransition(revision.approvalStatus, "REJECTED");

      return tx.brandRevision.update({
        where: { id: revision.id },
        data: {
          approvalStatus: "REJECTED",
          rejectedByUserId: actor.id,
          rejectedAt: now(),
          rejectionReason,
          approvedByUserId: null,
          approvedAt: null,
        },
      });
    },
    { isolationLevel: "Serializable" }
  );
}
