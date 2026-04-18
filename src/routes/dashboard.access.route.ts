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

function toLocalDateTimeString(date: Date) {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");

  let hours = date.getHours();
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const ampm = hours >= 12 ? "PM" : "AM";

  hours = hours % 12;
  if (hours === 0) hours = 12;

  return `${mm}/${dd}/${yyyy}, ${hours}:${minutes} ${ampm}`;
}

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
          property: { select: { id: true, name: true } },
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
      Reservation: {
        select: {
          guestName: true,
          roomName: true,
          property: { select: { id: true, name: true } },
        },
      },
    },
  });

  const nfc = nfcAssignments.map((a) => ({
    assignmentId: a.id,
    reservationId: a.reservationId,
    guestName: a.Reservation.guestName,
    roomName: a.Reservation.roomName ?? null,
    property: a.Reservation.property,
    role: a.role,
    status: a.status,
    card: {
      id: a.NfcCard.id,
      label: a.NfcCard.label ?? null,
      ttlockCardId: a.NfcCard.ttlockCardId,
    },
    startsAt: toLocalDateTimeString(a.startsAt),
    endsAt: toLocalDateTimeString(a.endsAt),
    lastError: a.lastError ?? null,
  }));

  return res.json({
    now: toLocalDateTimeString(now),
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
      startsAt: toLocalDateTimeString(g.startsAt),
      endsAt: toLocalDateTimeString(g.endsAt),
      codeMasked: g.accessCodeMasked ?? null,
      ttlockKeyboardPwdId: g.ttlockKeyboardPwdId ?? null,
      lastError: g.lastError ?? null,
    })),
    nfc,
    nfcGuest: nfc.filter((x) => x.role === "GUEST"),
    nfcCleaning: nfc.filter((x) => x.role === "CLEANING"),
  });
});