import {
  DamageCaseGuestResponse,
  DamageCaseStatus,
  PrismaClient,
} from "@prisma/client";
import { prisma as prismaSingleton } from "../lib/prisma";
import { GuestCancellationError } from "./guest-cancellation.service";

const RESPONSE_VERSION = "PROPERTY_PROTECTION_GUEST_RESPONSE_V1";
const MAX_RESPONSE_NOTE_LENGTH = 2000;

type GuestDamageResponseAction =
  | "ACKNOWLEDGED"
  | "ACCEPTED"
  | "DISPUTED";

function normalizeToken(value: unknown) {
  return String(value ?? "").trim();
}

function normalizeAction(value: unknown): GuestDamageResponseAction | null {
  const action = String(value ?? "").trim().toUpperCase();
  return action === "ACKNOWLEDGED" ||
    action === "ACCEPTED" ||
    action === "DISPUTED"
    ? action
    : null;
}

function normalizeNote(value: unknown) {
  const note = String(value ?? "").trim();
  return note || null;
}

function fail(code: string, message: string, statusCode: number): never {
  throw new GuestCancellationError({ code, message, statusCode });
}

function serializeResponse(damageCase: {
  id: string;
  guestResponse: DamageCaseGuestResponse;
  guestRespondedAt: Date | null;
  guestResponseNote: string | null;
  guestResponseVersion: string | null;
}) {
  return {
    damageCaseId: damageCase.id,
    guestResponse: damageCase.guestResponse,
    guestRespondedAt: damageCase.guestRespondedAt?.toISOString() ?? null,
    guestResponseNote: damageCase.guestResponseNote,
    guestResponseVersion: damageCase.guestResponseVersion,
    collectionStatus: "NO_CHARGE_MADE" as const,
  };
}

export async function recordGuestDamageCaseResponse(input: {
  guestToken: string;
  action: unknown;
  note?: unknown;
  prisma?: PrismaClient;
}) {
  const prisma = input.prisma ?? prismaSingleton;
  const guestToken = normalizeToken(input.guestToken);
  const action = normalizeAction(input.action);
  const note = normalizeNote(input.note);

  if (!guestToken) {
    fail("MISSING_GUEST_TOKEN", "Missing guest reservation token.", 400);
  }

  if (!action) {
    fail(
      "DAMAGE_CASE_GUEST_RESPONSE_INVALID",
      "Guest response must be ACKNOWLEDGED, ACCEPTED, or DISPUTED.",
      400
    );
  }

  if (note && note.length > MAX_RESPONSE_NOTE_LENGTH) {
    fail(
      "DAMAGE_CASE_GUEST_RESPONSE_NOTE_TOO_LONG",
      `Guest response note must not exceed ${MAX_RESPONSE_NOTE_LENGTH} characters.`,
      400
    );
  }

  if (action === "DISPUTED" && !note) {
    fail(
      "DAMAGE_CASE_GUEST_RESPONSE_NOTE_REQUIRED",
      "A dispute explanation is required.",
      400
    );
  }

  const reservation = await prisma.reservation.findFirst({
    where: {
      guestToken,
      OR: [
        { guestTokenExpiresAt: null },
        { guestTokenExpiresAt: { gt: new Date() } },
      ],
    },
    select: {
      id: true,
      source: true,
      externalProvider: true,
      stripeCheckoutSessionId: true,
      propertyProtectionRequiredSnapshot: true,
      damageCase: {
        select: {
          id: true,
          status: true,
          guestResponse: true,
          guestRespondedAt: true,
          guestResponseNote: true,
          guestResponseVersion: true,
        },
      },
    },
  });

  if (!reservation) {
    fail(
      "RESERVATION_NOT_FOUND_OR_TOKEN_EXPIRED",
      "Reservation not found or guest link has expired.",
      404
    );
  }

  const directBooking =
    reservation.source === "DIRECT_BOOKING" ||
    reservation.externalProvider === "PIN_GO_DIRECT" ||
    Boolean(reservation.stripeCheckoutSessionId);

  if (!directBooking) {
    fail(
      "NOT_DIRECT_BOOKING_RESERVATION",
      "Only Pin&Go Direct Booking reservations can be managed here.",
      400
    );
  }

  if (
    reservation.propertyProtectionRequiredSnapshot !== true ||
    !reservation.damageCase
  ) {
    fail(
      "DAMAGE_CASE_NOT_AVAILABLE",
      "No guest-visible Property Protection case is available.",
      404
    );
  }

  const damageCase = reservation.damageCase;

  if (damageCase.status !== DamageCaseStatus.GUEST_NOTIFIED) {
    fail(
      "DAMAGE_CASE_GUEST_RESPONSE_NOT_READY",
      "The Property Protection case is not ready for a guest response.",
      409
    );
  }

  const requestedResponse =
    action as Exclude<DamageCaseGuestResponse, "PENDING">;
  const responseNote = action === "DISPUTED" ? note : null;

  if (damageCase.guestResponse === requestedResponse) {
    if (
      action !== "DISPUTED" ||
      damageCase.guestResponseNote === responseNote
    ) {
      return {
        ok: true,
        alreadyRecorded: true,
        response: serializeResponse(damageCase),
      };
    }

    fail(
      "DAMAGE_CASE_GUEST_RESPONSE_FINAL",
      "The final guest response has already been recorded.",
      409
    );
  }

  if (
    damageCase.guestResponse === DamageCaseGuestResponse.ACCEPTED ||
    damageCase.guestResponse === DamageCaseGuestResponse.DISPUTED
  ) {
    fail(
      "DAMAGE_CASE_GUEST_RESPONSE_FINAL",
      "The final guest response has already been recorded.",
      409
    );
  }

  const respondedAt = new Date();
  const updated = await prisma.damageCase.updateMany({
    where: {
      id: damageCase.id,
      status: DamageCaseStatus.GUEST_NOTIFIED,
      guestResponse: damageCase.guestResponse,
    },
    data: {
      guestResponse: requestedResponse,
      guestRespondedAt: respondedAt,
      guestResponseNote: responseNote,
      guestResponseVersion: RESPONSE_VERSION,
    },
  });

  if (updated.count !== 1) {
    const concurrent = await prisma.damageCase.findUnique({
      where: { id: damageCase.id },
      select: {
        id: true,
        guestResponse: true,
        guestRespondedAt: true,
        guestResponseNote: true,
        guestResponseVersion: true,
      },
    });

    if (
      concurrent &&
      concurrent.guestResponse === requestedResponse &&
      (action !== "DISPUTED" ||
        concurrent.guestResponseNote === responseNote)
    ) {
      return {
        ok: true,
        alreadyRecorded: true,
        response: serializeResponse(concurrent),
      };
    }

    fail(
      "DAMAGE_CASE_GUEST_RESPONSE_CONFLICT",
      "The Damage Case response changed. Reload and try again.",
      409
    );
  }

  return {
    ok: true,
    alreadyRecorded: false,
    response: {
      damageCaseId: damageCase.id,
      guestResponse: requestedResponse,
      guestRespondedAt: respondedAt.toISOString(),
      guestResponseNote: responseNote,
      guestResponseVersion: RESPONSE_VERSION,
      collectionStatus: "NO_CHARGE_MADE" as const,
    },
  };
}
