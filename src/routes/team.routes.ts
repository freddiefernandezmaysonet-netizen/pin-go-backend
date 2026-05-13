import { Router } from "express";
import { PrismaClient, DashboardUserRole } from "@prisma/client";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { requireAuth } from "../middleware/requireAuth";

const prisma = new PrismaClient();
export const teamRouter = Router();

const ORG_ADMIN_ROLES: DashboardUserRole[] = [
  DashboardUserRole.ADMIN,
  DashboardUserRole.ORG_ADMIN,
  DashboardUserRole.PLATFORM_ADMIN,
];

const ALLOWED_CREATE_ROLES: DashboardUserRole[] = [
  DashboardUserRole.ADMIN,
  DashboardUserRole.MEMBER,
];

function getAuthUser(req: any) {
  return req.user;
}

function isOrgAdmin(role?: DashboardUserRole | string | null) {
  return !!role && ORG_ADMIN_ROLES.includes(role as DashboardUserRole);
}

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

function makeTemporaryPassword() {
  return crypto.randomBytes(12).toString("base64url");
}

async function requireOrgAdmin(req: any, res: any) {
  const authUser = getAuthUser(req);

  if (!authUser?.id) {
    res.status(401).json({ ok: false, error: "Unauthorized" });
    return null;
  }

  const dbUser = await prisma.dashboardUser.findUnique({
    where: { id: authUser.id },
    select: {
      id: true,
      organizationId: true,
      role: true,
      isActive: true,
      email: true,
    },
  });

  if (!dbUser || !dbUser.isActive) {
    res.status(401).json({ ok: false, error: "Unauthorized" });
    return null;
  }

  if (!isOrgAdmin(dbUser.role)) {
    res.status(403).json({ ok: false, error: "Admin access required" });
    return null;
  }

  return dbUser;
}

/**
 * GET /api/team/users
 * List organization users.
 */
teamRouter.get("/api/team/users", requireAuth, async (req: any, res) => {
  try {
    const admin = await requireOrgAdmin(req, res);
    if (!admin) return;

    const users = await prisma.dashboardUser.findMany({
      where: {
        organizationId: admin.organizationId,
      },
      orderBy: [{ isActive: "desc" }, { createdAt: "asc" }],
      select: {
        id: true,
        email: true,
        fullName: true,
        role: true,
        isActive: true,
        lastLoginAt: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    res.json({ ok: true, users });
  } catch (error) {
    console.error("[team users list]", error);
    res.status(500).json({ ok: false, error: "Failed to list team users" });
  }
});

/**
 * POST /api/team/users
 * Create user inside same organization.
 *
 * Body:
 * {
 *   "email": "member@example.com",
 *   "fullName": "Member Name",
 *   "role": "MEMBER"
 * }
 */
teamRouter.post("/api/team/users", requireAuth, async (req: any, res) => {
  try {
    const admin = await requireOrgAdmin(req, res);
    if (!admin) return;

    const email =
      typeof req.body?.email === "string" ? normalizeEmail(req.body.email) : "";

    const fullName =
      typeof req.body?.fullName === "string"
        ? req.body.fullName.trim()
        : undefined;

    const requestedRole =
      typeof req.body?.role === "string"
        ? (req.body.role as DashboardUserRole)
        : DashboardUserRole.MEMBER;

    if (!email || !email.includes("@")) {
      return res.status(400).json({ ok: false, error: "Valid email required" });
    }

    if (!ALLOWED_CREATE_ROLES.includes(requestedRole)) {
      return res.status(400).json({
        ok: false,
        error: "Invalid role. Allowed roles: ADMIN, MEMBER",
      });
    }

    const existing = await prisma.dashboardUser.findUnique({
      where: { email },
      select: { id: true },
    });

    if (existing) {
      return res.status(409).json({
        ok: false,
        error: "A user with this email already exists",
      });
    }

    const temporaryPassword = makeTemporaryPassword();
    const passwordHash = await bcrypt.hash(temporaryPassword, 12);

    const user = await prisma.dashboardUser.create({
      data: {
        organizationId: admin.organizationId,
        email,
        fullName,
        role: requestedRole,
        passwordHash,
        isActive: true,
      },
      select: {
        id: true,
        email: true,
        fullName: true,
        role: true,
        isActive: true,
        createdAt: true,
      },
    });

    res.status(201).json({
      ok: true,
      user,
      temporaryPassword,
      message:
        "User created. Temporary password is returned once. Ask the user to reset it after first login.",
    });
  } catch (error) {
    console.error("[team users create]", error);
    res.status(500).json({ ok: false, error: "Failed to create team user" });
  }
});

/**
 * PATCH /api/team/users/:userId
 * Update user role/name/status inside same organization.
 */
teamRouter.patch("/api/team/users/:userId", requireAuth, async (req: any, res) => {
  try {
    const admin = await requireOrgAdmin(req, res);
    if (!admin) return;

    const { userId } = req.params;

    const target = await prisma.dashboardUser.findFirst({
      where: {
        id: userId,
        organizationId: admin.organizationId,
      },
      select: {
        id: true,
        role: true,
        isActive: true,
      },
    });

    if (!target) {
      return res.status(404).json({ ok: false, error: "User not found" });
    }

    const data: {
      fullName?: string | null;
      role?: DashboardUserRole;
      isActive?: boolean;
      tokenVersion?: { increment: number };
    } = {};

    if (typeof req.body?.fullName === "string") {
      data.fullName = req.body.fullName.trim() || null;
    }

    if (typeof req.body?.role === "string") {
      const nextRole = req.body.role as DashboardUserRole;

      if (!ALLOWED_CREATE_ROLES.includes(nextRole)) {
        return res.status(400).json({
          ok: false,
          error: "Invalid role. Allowed roles: ADMIN, MEMBER",
        });
      }

      data.role = nextRole;
    }

    if (typeof req.body?.isActive === "boolean") {
      if (target.id === admin.id && req.body.isActive === false) {
        return res.status(400).json({
          ok: false,
          error: "You cannot deactivate your own user",
        });
      }

      data.isActive = req.body.isActive;
      data.tokenVersion = { increment: 1 };
    }

    const updated = await prisma.dashboardUser.update({
      where: { id: target.id },
      data,
      select: {
        id: true,
        email: true,
        fullName: true,
        role: true,
        isActive: true,
        lastLoginAt: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    res.json({ ok: true, user: updated });
  } catch (error) {
    console.error("[team users update]", error);
    res.status(500).json({ ok: false, error: "Failed to update team user" });
  }
});

/**
 * POST /api/team/users/:userId/reset-password
 * Generate temporary password for user inside same organization.
 */
teamRouter.post(
  "/api/team/users/:userId/reset-password",
  requireAuth,
  async (req: any, res) => {
    try {
      const admin = await requireOrgAdmin(req, res);
      if (!admin) return;

      const { userId } = req.params;

      const target = await prisma.dashboardUser.findFirst({
        where: {
          id: userId,
          organizationId: admin.organizationId,
          isActive: true,
        },
        select: {
          id: true,
          email: true,
        },
      });

      if (!target) {
        return res.status(404).json({ ok: false, error: "User not found" });
      }

      const temporaryPassword = makeTemporaryPassword();
      const passwordHash = await bcrypt.hash(temporaryPassword, 12);

      await prisma.dashboardUser.update({
        where: { id: target.id },
        data: {
          passwordHash,
          tokenVersion: { increment: 1 },
        },
      });

      res.json({
        ok: true,
        email: target.email,
        temporaryPassword,
        message:
          "Temporary password generated. It is returned once and existing sessions were invalidated.",
      });
    } catch (error) {
      console.error("[team users reset password]", error);
      res.status(500).json({
        ok: false,
        error: "Failed to reset team user password",
      });
    }
  }
);