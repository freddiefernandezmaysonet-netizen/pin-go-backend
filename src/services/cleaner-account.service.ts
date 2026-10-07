import { createHash, randomBytes } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { hashPassword } from "../lib/auth.js";
import { validatePasswordPolicy } from "../lib/passwordPolicy.js";

export class CleanerAccountError extends Error {
  constructor(public code: string, public status = 409) { super(code); }
}
export function activationHash(token: string) {
  if (!/^[a-f0-9]{48}$/.test(token)) throw new CleanerAccountError("ACTIVATION_INVALID", 410);
  return createHash("sha256").update(token).digest("hex");
}
export function cleanerEmail(raw: unknown) {
  const email = String(raw ?? "").trim().toLowerCase();
  if (email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new CleanerAccountError("EMAIL_INVALID", 400);
  return email;
}

export async function requestCleanerAccount(prisma: PrismaClient, orgId: string, staffId: string, rawEmail: unknown, now = new Date()) {
  const email = cleanerEmail(rawEmail);
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT "id" FROM "StaffMember" WHERE "id" = ${staffId} FOR UPDATE`;
    const staff = await tx.staffMember.findFirst({ where: { id: staffId, organizationId: orgId, isActive: true } });
    if (!staff) throw new CleanerAccountError("STAFF_NOT_FOUND", 404);
    if (staff.dashboardUserId) throw new CleanerAccountError("STAFF_ACCOUNT_ALREADY_LINKED");
    if (await tx.dashboardUser.findUnique({ where: { email }, select: { id: true } })) throw new CleanerAccountError("EMAIL_ALREADY_REGISTERED");
    if (staff.cleanerAccountEmail === email && staff.cleanerAccountRequestedAt) return { status: "AWAITING_ACTIVATION", email };
    await tx.cleanerAccountActivation.deleteMany({ where: { staffMemberId: staffId, consumedAt: null } });
    await tx.staffMember.update({ where: { id: staffId }, data: { cleanerAccountEmail: email, cleanerAccountRequestedAt: now } });
    return { status: "AWAITING_ACTIVATION", email };
  });
}

/** Issued only when building a new existing confirmation SMS, never from an old offer token. */
export async function issueCleanerActivation(prisma: PrismaClient, confirmationId: string, now = new Date()) {
  return prisma.$transaction(async tx => {
    const confirmation = await tx.cleaningConfirmation.findUnique({ where: { id: confirmationId } });
    if (!confirmation || confirmation.status !== "PENDING") return null;
    await tx.$queryRaw`SELECT "id" FROM "StaffMember" WHERE "id" = ${confirmation.staffMemberId} FOR UPDATE`;
    const staff = await tx.staffMember.findUnique({ where: { id: confirmation.staffMemberId } });
    if (!staff?.isActive || staff.dashboardUserId || !staff.cleanerAccountEmail || !staff.cleanerAccountRequestedAt) return null;
    const reservation = await tx.reservation.findFirst({ where: { id: confirmation.reservationId, propertyId: confirmation.propertyId, status: "ACTIVE", property: { organizationId: staff.organizationId } } });
    if (!reservation) return null;
    const token = randomBytes(24).toString("hex");
    await tx.cleanerAccountActivation.create({ data: {
      staffMemberId: staff.id, confirmationId, email: staff.cleanerAccountEmail,
      requestedAt: staff.cleanerAccountRequestedAt, tokenHash: activationHash(token),
      expiresAt: new Date(now.getTime() + 48 * 60 * 60 * 1000),
    } });
    return token;
  });
}

export async function loadCleanerActivation(prisma: Pick<PrismaClient, "cleanerAccountActivation" | "cleaningConfirmation" | "reservation" | "cleaningWork">, token: string, now = new Date()) {
  const activation = await prisma.cleanerAccountActivation.findUnique({ where: { tokenHash: activationHash(token) }, include: { staffMember: true } });
  const staff = activation?.staffMember;
  if (!activation || activation.consumedAt || activation.expiresAt <= now || !staff?.isActive || staff.dashboardUserId ||
      staff.cleanerAccountEmail !== activation.email || staff.cleanerAccountRequestedAt?.getTime() !== activation.requestedAt.getTime()) {
    throw new CleanerAccountError("ACTIVATION_INVALID", 410);
  }
  const confirmation = await prisma.cleaningConfirmation.findFirst({ where: { id: activation.confirmationId, staffMemberId: staff.id, status: { in: ["PENDING", "CONFIRMED"] } } });
  const reservation = confirmation && await prisma.reservation.findFirst({ where: { id: confirmation.reservationId, propertyId: confirmation.propertyId, status: "ACTIVE", property: { organizationId: staff.organizationId } } });
  const closed = confirmation && await prisma.cleaningWork.findFirst({ where: { confirmationId: confirmation.id, staffMemberId: staff.id, OR: [{ cancelledAt: { not: null } }, { supersededAt: { not: null } }] }, select: { id: true } });
  if (!reservation || closed) throw new CleanerAccountError("ACTIVATION_INVALID", 410);
  return activation;
}

export async function activateCleanerAccount(prisma: PrismaClient, token: string, rawEmail: unknown, password: string, now = new Date()) {
  const email = cleanerEmail(rawEmail);
  const preview = await loadCleanerActivation(prisma, token, now);
  if (email !== preview.email) throw new CleanerAccountError("ACTIVATION_EMAIL_MISMATCH", 400);
  const policy = validatePasswordPolicy(password, { email, fullName: preview.staffMember.fullName });
  if (!policy.ok || password.length > 128) throw new CleanerAccountError("PASSWORD_POLICY_REQUIRED", 400);
  const passwordHash = await hashPassword(password);
  try {
    return await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "StaffMember" WHERE "id" = ${preview.staffMemberId} FOR UPDATE`;
      const current = await loadCleanerActivation(tx, token, now);
      if (await tx.dashboardUser.findUnique({ where: { email }, select: { id: true } })) throw new CleanerAccountError("EMAIL_ALREADY_REGISTERED");
      const user = await tx.dashboardUser.create({ data: {
        email, passwordHash, fullName: current.staffMember.fullName, role: "CLEANER",
        organizationId: current.staffMember.organizationId, isActive: true, tokenVersion: 1,
      }, select: { id: true } });
      await tx.staffMember.update({ where: { id: current.staffMemberId }, data: { dashboardUserId: user.id } });
      await tx.cleanerAccountActivation.updateMany({ where: { staffMemberId: current.staffMemberId, consumedAt: null }, data: { consumedAt: now } });
      return { activated: true };
    });
  } catch (error: any) {
    if (error?.code === "P2002") throw new CleanerAccountError("EMAIL_ALREADY_REGISTERED");
    throw error;
  }
}
