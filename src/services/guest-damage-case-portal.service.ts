import { DamageCaseStatus, PrismaClient } from "@prisma/client";

const GUEST_VISIBLE_DAMAGE_CASE_STATUSES = [
  DamageCaseStatus.GUEST_NOTIFICATION_PENDING,
  DamageCaseStatus.GUEST_NOTIFIED,
  DamageCaseStatus.CHARGE_BLOCKED,
  DamageCaseStatus.CLOSED_NO_CHARGE,
] as const;

export class GuestDamageCaseError extends Error {
  statusCode: number;
  code: string;

  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.name = "GuestDamageCaseError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export async function getGuestDamageCasePortalView(
  prisma: PrismaClient,
  input: { guestToken: unknown; now?: Date }
) {
  const guestToken = String(input.guestToken ?? "").trim();
  const now = input.now ?? new Date();

  if (!guestToken) {
    throw new GuestDamageCaseError(
      "MISSING_GUEST_TOKEN",
      "Missing guest reservation token.",
      400
    );
  }

  const reservation = await prisma.reservation.findFirst({
    where: {
      guestToken,
      OR: [
        { guestTokenExpiresAt: null },
        { guestTokenExpiresAt: { gt: now } },
      ],
    },
    select: {
      reservationNumber: true,
      roomName: true,
      currency: true,
      propertyProtectionRequiredSnapshot: true,
      propertyProtectionModeSnapshot: true,
      maxDamageLiabilityAmountSnapshot: true,
      damageCase: {
        select: {
          id: true,
          status: true,
          requestedAmount: true,
          approvedAmount: true,
          currency: true,
          description: true,
          evidence: true,
          hostApprovedAt: true,
          guestNotifiedAt: true,
          closedAt: true,
          closedReason: true,
          updatedAt: true,
        },
      },
      property: {
        select: {
          name: true,
        },
      },
    },
  });

  if (!reservation) {
    throw new GuestDamageCaseError(
      "RESERVATION_NOT_FOUND_OR_TOKEN_EXPIRED",
      "Reservation not found or guest link has expired.",
      404
    );
  }

  if (reservation.propertyProtectionRequiredSnapshot !== true) {
    return { ok: true, propertyProtection: null, damageCase: null };
  }

  const damageCase = reservation.damageCase;
  const guestVisible =
    damageCase &&
    GUEST_VISIBLE_DAMAGE_CASE_STATUSES.includes(
      damageCase.status as (typeof GUEST_VISIBLE_DAMAGE_CASE_STATUSES)[number]
    );

  return {
    ok: true,
    propertyProtection: {
      mode: reservation.propertyProtectionModeSnapshot ?? "CARD_ON_FILE",
      maxDamageLiabilityAmount:
        reservation.maxDamageLiabilityAmountSnapshot === null
          ? null
          : Number(reservation.maxDamageLiabilityAmountSnapshot),
      currency: reservation.currency ?? "usd",
    },
    reservation: {
      reservationNumber: reservation.reservationNumber,
      propertyName: reservation.property?.name ?? reservation.roomName ?? "Your stay",
    },
    damageCase: guestVisible && damageCase
      ? {
          id: damageCase.id,
          status: damageCase.status,
          requestedAmount: Number(damageCase.requestedAmount),
          approvedAmount:
            damageCase.approvedAmount === null
              ? null
              : Number(damageCase.approvedAmount),
          currency: damageCase.currency,
          description: damageCase.description,
          evidence: damageCase.evidence,
          hostApprovedAt: damageCase.hostApprovedAt?.toISOString() ?? null,
          guestNotifiedAt: damageCase.guestNotifiedAt?.toISOString() ?? null,
          closedAt: damageCase.closedAt?.toISOString() ?? null,
          closedReason: damageCase.closedReason,
          updatedAt: damageCase.updatedAt.toISOString(),
          chargeExecuted: false,
        }
      : null,
  };
}
