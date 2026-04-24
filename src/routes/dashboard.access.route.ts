import { Router } from "express";
import {
  PrismaClient,
  AccessStatus,
  AccessMethod,
  AccessGrantType,
  NfcAssignmentStatus,
} from "@prisma/client";
import { requireAuth } from "../middleware/requireAuth";

const prisma = new PrismaClient();
export const dashboardAccessRouter = Router();

dashboardAccessRouter.get("/api/dashboard/access", requireAuth, async (req, res) => {
  const user = (req as any).user;
  const orgId = user.orgId as string;

  const propertyId =
    typeof req.query.propertyId === "string" ? req.query.propertyId : undefined;

  const now = new Date();

  const reservationOrgWhere = propertyId
    ? { property: { id: propertyId, organizationId: orgId } }
    : { property: { organizationId: orgId } };

  const guestPasscodes = await prisma.accessGrant.findMany({
    where: {
      status: AccessStatus.ACTIVE,
      method: AccessMethod.PASSCODE_TIMEBOUND,
      type: AccessGrantType.GUEST,
      startsAt: { lte: now },
      endsAt: { gt: now },
      reservation: reservationOrgWhere,
    },
    orderBy: { startsAt: "asc" },
    take: 200,
    select: {
      id: true,
      reservationId: true,
      startsAt: true,
      endsAt: true,
      accessCodeMasked: true,
      ttlockKeyboardPwdId: true,
      lastError: true,
      lock: { select: { ttlockLockId: true, ttlockLockName: true } },
      reservation: {
        select: {
          guestName: true,
          roomName: true,
          property: { select: { id: true, name: true, timezone: true } },
        },
      },
    },
  });

  const nfcAssignments = await prisma.nfcAssignment.findMany({
    where: {
      status: NfcAssignmentStatus.ACTIVE,
      startsAt: { lte: now },
      endsAt: { gt: now },
      Reservation: reservationOrgWhere,
    },
    orderBy: { startsAt: "asc" },
    take: 300,
    select: {
      id: true,
      reservationId: true,
      role: true,
      status: true,
      startsAt: true,
      endsAt: true,
      lastError: true,
      NfcCard: { select: { id: true, label: true, ttlockCardId: true } },
       staffMember: {
    select: {
      fullName: true,
    },
  },
      Reservation: {
        select: {
          guestName: true,
          roomName: true,
          property: { select: { id: true, name: true, timezone: true  } },
        },
      },
    },
  });

  const nfc = nfcAssignments.map((a) => ({
    assignmentId: a.id,
    reservationId: a.reservationId,
    guestName: a.Reservation.guestName,
    staffName: a.staffMember?.fullName ?? null,
    roomName: a.Reservation.roomName ?? null,
    property: a.Reservation.property,
    role: a.role,
    status: a.status,
    card: {
      id: a.NfcCard.id,
      label: a.NfcCard.label ?? null,
      ttlockCardId: a.NfcCard.ttlockCardId,
    },
    startsAt: a.startsAt.toISOString(),
    endsAt: a.endsAt.toISOString(),
    lastError: a.lastError ?? null,
  }));

  return res.json({
    now: now.toISOString(),
    guestPasscodes: guestPasscodes.map((g) => ({
      grantId: g.id,
      reservationId: g.reservationId,
      guestName: g.reservation?.guestName ?? "—",
      roomName: g.reservation?.roomName ?? null,
      property: g.reservation?.property ?? null,
      lock: {
        ttlockLockId: g.lock.ttlockLockId,
        name: g.lock.ttlockLockName ?? null,
      },
      startsAt: g.startsAt.toISOString(),
      endsAt: g.endsAt.toISOString(),
      codeMasked: g.accessCodeMasked ?? null,
      ttlockKeyboardPwdId: g.ttlockKeyboardPwdId ?? null,
      lastError: g.lastError ?? null,
    })),
    nfc,
    nfcGuest: nfc.filter((x) => x.role === "GUEST"),
    nfcCleaning: nfc.filter((x) => x.role === "CLEANING"),
  });
});