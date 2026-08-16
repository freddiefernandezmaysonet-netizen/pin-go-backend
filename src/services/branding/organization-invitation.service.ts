import { createHash, randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { validatePasswordPolicy } from "../../lib/passwordPolicy.js";
import { prisma } from "../../lib/prisma.js";
import { requireBrandManagerRole } from "./brand-policy.js";

const INVITATION_LIFETIME_MS = 72 * 60 * 60 * 1000;
const INVITATION_TOKEN_BYTES = 32;
const INVITATION_TOKEN_LENGTH = 43;

export type OrganizationInvitationErrorCode =
  | "ORGANIZATION_INVITATION_INPUT_INVALID"
  | "ORGANIZATION_INVITATION_ACTOR_NOT_FOUND"
  | "ORGANIZATION_INVITATION_ACTOR_INACTIVE"
  | "ORGANIZATION_INVITATION_ORGANIZATION_NOT_FOUND"
  | "ORGANIZATION_INVITATION_NOT_FOUND"
  | "ORGANIZATION_INVITATION_ALREADY_ACCEPTED"
  | "ORGANIZATION_INVITATION_REVOKED"
  | "ORGANIZATION_INVITATION_EXPIRED"
  | "ORGANIZATION_INVITATION_ROLE_INVALID"
  | "ORGANIZATION_INVITATION_EMAIL_REGISTERED"
  | "ORGANIZATION_INVITATION_PASSWORD_WEAK";

export class OrganizationInvitationError extends Error {
  constructor(
    readonly code: OrganizationInvitationErrorCode,
    message: string,
    readonly context: Readonly<Record<string, unknown>> = {}
  ) {
    super(`${code}: ${message}`);
    this.name = "OrganizationInvitationError";
  }
}

export type OrganizationInvitationActorInput = {
  userId: string;
};

export type CreateOrganizationOwnerInvitationInput = {
  actor: OrganizationInvitationActorInput;
  organizationId: string;
  email: string;
};

export type AcceptOrganizationOwnerInvitationInput = {
  token: string;
  fullName: string;
  password: string;
};

export type InspectOrganizationOwnerInvitationInput = {
  token: string;
};

export type RevokeOrganizationOwnerInvitationInput = {
  actor: OrganizationInvitationActorInput;
  invitationId: string;
};

export type OrganizationInvitationServiceOptions = {
  db?: typeof prisma;
  now?: () => Date;
  generateToken?: () => string;
  passwordHasher?: (password: string) => Promise<string>;
};

type OrganizationInvitationTransactionClient = Pick<
  typeof prisma,
  "dashboardUser" | "organization" | "organizationInvitation"
>;

type InvitationAcceptanceRecord = {
  id: string;
  organizationId: string;
  email: string;
  role: "ADMIN" | "MEMBER" | "PLATFORM_ADMIN" | "ORG_ADMIN";
  expiresAt: Date;
  acceptedAt: Date | null;
  revokedAt: Date | null;
  organization: {
    id: string;
    name: string;
  };
};

function invitationTransactionClient(
  transaction: unknown
): OrganizationInvitationTransactionClient {
  return transaction as OrganizationInvitationTransactionClient;
}

function requiredText(
  value: string | null | undefined,
  field: string
): string {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    throw new OrganizationInvitationError(
      "ORGANIZATION_INVITATION_INPUT_INVALID",
      `${field} is required.`,
      { field }
    );
  }
  return normalized;
}

function normalizeEmail(rawEmail: string): string {
  const email = requiredText(rawEmail, "email").toLowerCase();
  if (
    email.length > 320 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  ) {
    throw new OrganizationInvitationError(
      "ORGANIZATION_INVITATION_INPUT_INVALID",
      "email must be a valid email address.",
      { field: "email" }
    );
  }
  return email;
}

function normalizeFullName(rawFullName: string): string {
  const fullName = requiredText(rawFullName, "fullName");
  if (
    fullName.length < 2 ||
    fullName.length > 120 ||
    /[\r\n]/.test(fullName)
  ) {
    throw new OrganizationInvitationError(
      "ORGANIZATION_INVITATION_INPUT_INVALID",
      "fullName must contain between 2 and 120 characters on one line.",
      { field: "fullName" }
    );
  }
  return fullName;
}

function generateOrganizationInvitationToken(): string {
  return randomBytes(INVITATION_TOKEN_BYTES).toString("base64url");
}

async function hashOrganizationOwnerPassword(
  password: string
): Promise<string> {
  return bcrypt.hash(String(password ?? "").trim(), 10);
}

function normalizeInvitationToken(rawToken: string): string {
  const token = requiredText(rawToken, "token");
  if (
    token.length !== INVITATION_TOKEN_LENGTH ||
    !/^[A-Za-z0-9_-]+$/.test(token)
  ) {
    throw new OrganizationInvitationError(
      "ORGANIZATION_INVITATION_INPUT_INVALID",
      "The invitation token format is invalid.",
      { field: "token" }
    );
  }
  return token;
}

function hashInvitationToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function maskInvitationEmail(email: string): string {
  const separatorIndex = email.lastIndexOf("@");
  if (separatorIndex <= 0 || separatorIndex === email.length - 1) {
    return "***";
  }
  const localPart = email.slice(0, separatorIndex);
  const domain = email.slice(separatorIndex + 1);
  return `${localPart.slice(0, 1)}***@${domain}`;
}

function requireValidGeneratedToken(token: string): string {
  return normalizeInvitationToken(token);
}

async function requireActivePlatformAdmin(
  tx: OrganizationInvitationTransactionClient,
  rawUserId: string
): Promise<string> {
  const userId = requiredText(rawUserId, "actor.userId");
  const actor = await tx.dashboardUser.findUnique({
    where: { id: userId },
    select: {
      id: true,
      role: true,
      isActive: true,
    },
  });

  if (!actor) {
    throw new OrganizationInvitationError(
      "ORGANIZATION_INVITATION_ACTOR_NOT_FOUND",
      "The invitation manager account does not exist.",
      { userId }
    );
  }
  if (!actor.isActive) {
    throw new OrganizationInvitationError(
      "ORGANIZATION_INVITATION_ACTOR_INACTIVE",
      "The invitation manager account is inactive.",
      { userId }
    );
  }

  requireBrandManagerRole(actor.role);
  return actor.id;
}

function requireOpenOwnerInvitation(
  invitation: InvitationAcceptanceRecord | null,
  now: Date
): InvitationAcceptanceRecord {
  if (!invitation) {
    throw new OrganizationInvitationError(
      "ORGANIZATION_INVITATION_NOT_FOUND",
      "The invitation does not exist."
    );
  }
  if (invitation.acceptedAt) {
    throw new OrganizationInvitationError(
      "ORGANIZATION_INVITATION_ALREADY_ACCEPTED",
      "The invitation has already been accepted.",
      { invitationId: invitation.id }
    );
  }
  if (invitation.revokedAt) {
    throw new OrganizationInvitationError(
      "ORGANIZATION_INVITATION_REVOKED",
      "The invitation has been revoked.",
      { invitationId: invitation.id }
    );
  }
  if (invitation.expiresAt.getTime() <= now.getTime()) {
    throw new OrganizationInvitationError(
      "ORGANIZATION_INVITATION_EXPIRED",
      "The invitation has expired.",
      { invitationId: invitation.id }
    );
  }
  if (invitation.role !== "ORG_ADMIN") {
    throw new OrganizationInvitationError(
      "ORGANIZATION_INVITATION_ROLE_INVALID",
      "The invitation is not an organization-owner invitation.",
      { invitationId: invitation.id, role: invitation.role }
    );
  }

  return invitation;
}

const INVITATION_ACCEPTANCE_SELECT = {
  id: true,
  organizationId: true,
  email: true,
  role: true,
  expiresAt: true,
  acceptedAt: true,
  revokedAt: true,
  organization: {
    select: {
      id: true,
      name: true,
    },
  },
} as const;

export async function createOrganizationOwnerInvitation(
  input: CreateOrganizationOwnerInvitationInput,
  options: OrganizationInvitationServiceOptions = {}
) {
  const db = options.db ?? prisma;
  const now = options.now ?? (() => new Date());
  const generateToken =
    options.generateToken ?? generateOrganizationInvitationToken;
  const organizationId = requiredText(
    input.organizationId,
    "organizationId"
  );
  const email = normalizeEmail(input.email);
  const token = requireValidGeneratedToken(generateToken());
  const tokenHash = hashInvitationToken(token);
  const createdAt = now();
  const expiresAt = new Date(
    createdAt.getTime() + INVITATION_LIFETIME_MS
  );

  const invitation = await db.$transaction(
    async (transaction) => {
      const tx = invitationTransactionClient(transaction);
      const actorUserId = await requireActivePlatformAdmin(
        tx,
        input.actor.userId
      );
      const organization = await tx.organization.findUnique({
        where: { id: organizationId },
        select: { id: true, name: true },
      });
      if (!organization) {
        throw new OrganizationInvitationError(
          "ORGANIZATION_INVITATION_ORGANIZATION_NOT_FOUND",
          "The organization does not exist.",
          { organizationId }
        );
      }

      const existingUser = await tx.dashboardUser.findUnique({
        where: { email },
        select: { id: true },
      });
      if (existingUser) {
        throw new OrganizationInvitationError(
          "ORGANIZATION_INVITATION_EMAIL_REGISTERED",
          "The invitation email already belongs to a dashboard user.",
          { email }
        );
      }

      await tx.organizationInvitation.updateMany({
        where: {
          organizationId,
          email,
          acceptedAt: null,
          revokedAt: null,
        },
        data: { revokedAt: createdAt },
      });

      return tx.organizationInvitation.create({
        data: {
          organizationId,
          email,
          role: "ORG_ADMIN",
          tokenHash,
          expiresAt,
          createdByUserId: actorUserId,
        },
        select: {
          id: true,
          organizationId: true,
          email: true,
          role: true,
          expiresAt: true,
          createdAt: true,
        },
      });
    },
    { isolationLevel: "Serializable" }
  );

  return {
    invitation,
    token,
  };
}

export async function acceptOrganizationOwnerInvitation(
  input: AcceptOrganizationOwnerInvitationInput,
  options: OrganizationInvitationServiceOptions = {}
) {
  const db = options.db ?? prisma;
  const now = options.now ?? (() => new Date());
  const passwordHasher =
    options.passwordHasher ?? hashOrganizationOwnerPassword;
  const token = normalizeInvitationToken(input.token);
  const tokenHash = hashInvitationToken(token);
  const fullName = normalizeFullName(input.fullName);

  const initialInvitation = (await db.organizationInvitation.findUnique({
    where: { tokenHash },
    select: INVITATION_ACCEPTANCE_SELECT,
  })) as InvitationAcceptanceRecord | null;
  const invitation = requireOpenOwnerInvitation(
    initialInvitation,
    now()
  );

  const passwordPolicy = validatePasswordPolicy(input.password, {
    email: invitation.email,
    fullName,
    organizationName: invitation.organization.name,
  });
  if (!passwordPolicy.ok) {
    throw new OrganizationInvitationError(
      "ORGANIZATION_INVITATION_PASSWORD_WEAK",
      "The password does not meet the Pin&Go password policy.",
      { errors: passwordPolicy.errors }
    );
  }
  const passwordHash = await passwordHasher(input.password);

  return db.$transaction(
    async (transaction) => {
      const tx = invitationTransactionClient(transaction);
      const acceptedAt = now();
      const currentInvitation = (await tx.organizationInvitation.findUnique({
        where: { tokenHash },
        select: INVITATION_ACCEPTANCE_SELECT,
      })) as InvitationAcceptanceRecord | null;
      const current = requireOpenOwnerInvitation(
        currentInvitation,
        acceptedAt
      );

      const existingUser = await tx.dashboardUser.findUnique({
        where: { email: current.email },
        select: { id: true },
      });
      if (existingUser) {
        throw new OrganizationInvitationError(
          "ORGANIZATION_INVITATION_EMAIL_REGISTERED",
          "The invitation email already belongs to a dashboard user.",
          { email: current.email }
        );
      }

      const user = await tx.dashboardUser.create({
        data: {
          organizationId: current.organizationId,
          email: current.email,
          passwordHash,
          fullName,
          role: "ORG_ADMIN",
          isActive: true,
          tokenVersion: 1,
        },
        select: {
          id: true,
          organizationId: true,
          email: true,
          fullName: true,
          role: true,
          isActive: true,
          tokenVersion: true,
          createdAt: true,
        },
      });

      const consumed = await tx.organizationInvitation.updateMany({
        where: {
          id: current.id,
          tokenHash,
          acceptedAt: null,
          revokedAt: null,
          expiresAt: { gt: acceptedAt },
        },
        data: {
          acceptedAt,
          acceptedUserId: user.id,
        },
      });
      if (consumed.count !== 1) {
        throw new OrganizationInvitationError(
          "ORGANIZATION_INVITATION_ALREADY_ACCEPTED",
          "The invitation could not be consumed exactly once.",
          { invitationId: current.id }
        );
      }

      return {
        user,
        invitation: {
          id: current.id,
          organizationId: current.organizationId,
          acceptedAt,
        },
      };
    },
    { isolationLevel: "Serializable" }
  );
}

export async function inspectOrganizationOwnerInvitation(
  input: InspectOrganizationOwnerInvitationInput,
  options: OrganizationInvitationServiceOptions = {}
) {
  const db = options.db ?? prisma;
  const now = options.now ?? (() => new Date());
  const token = normalizeInvitationToken(input.token);
  const tokenHash = hashInvitationToken(token);
  const invitation = (await db.organizationInvitation.findUnique({
    where: { tokenHash },
    select: INVITATION_ACCEPTANCE_SELECT,
  })) as InvitationAcceptanceRecord | null;
  const openInvitation = requireOpenOwnerInvitation(invitation, now());

  return {
    organizationName: openInvitation.organization.name,
    ownerEmailHint: maskInvitationEmail(openInvitation.email),
    expiresAt: openInvitation.expiresAt,
  };
}

export async function revokeOrganizationOwnerInvitation(
  input: RevokeOrganizationOwnerInvitationInput,
  options: OrganizationInvitationServiceOptions = {}
) {
  const db = options.db ?? prisma;
  const now = options.now ?? (() => new Date());
  const invitationId = requiredText(input.invitationId, "invitationId");

  return db.$transaction(
    async (transaction) => {
      const tx = invitationTransactionClient(transaction);
      await requireActivePlatformAdmin(tx, input.actor.userId);
      const invitation = await tx.organizationInvitation.findUnique({
        where: { id: invitationId },
        select: {
          id: true,
          acceptedAt: true,
          revokedAt: true,
        },
      });
      if (!invitation) {
        throw new OrganizationInvitationError(
          "ORGANIZATION_INVITATION_NOT_FOUND",
          "The invitation does not exist.",
          { invitationId }
        );
      }
      if (invitation.acceptedAt) {
        throw new OrganizationInvitationError(
          "ORGANIZATION_INVITATION_ALREADY_ACCEPTED",
          "An accepted invitation cannot be revoked.",
          { invitationId }
        );
      }
      if (invitation.revokedAt) return invitation;

      return tx.organizationInvitation.update({
        where: { id: invitation.id },
        data: { revokedAt: now() },
        select: {
          id: true,
          acceptedAt: true,
          revokedAt: true,
        },
      });
    },
    { isolationLevel: "Serializable" }
  );
}
