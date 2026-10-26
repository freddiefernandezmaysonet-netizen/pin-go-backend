import { createHash, randomBytes, randomInt } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import { resolveChannexOperationalProvider } from "../services/ota-guest-external-messaging.policy.js";

export const activationHash = (value: string) => createHash("sha256").update(value).digest("hex");
export const ACTIVATION_PREFIX = "gact_";
const TOKEN = /^[A-Za-z0-9_-]{16,200}$/;
const TEN_MINUTES = 10 * 60_000;

export class GuestAppActivationError extends Error {
  constructor(readonly code: "UNAVAILABLE" | "RATE_LIMITED" | "INVALID_CODE" | "DELIVERY_FAILED") {
    super(`GUEST_APP_ACTIVATION_${code}`);
  }
}

export function activeAppStayWhere(now: Date) {
  return {
    status: "ACTIVE" as const, cancelledAt: null,
    checkOut: { gt: now }, guestTokenExpiresAt: { gt: now },
    property: { status: "ACTIVE" as const },
    OR: [{ guestStayLink: null }, { guestStayLink: { revokedAt: null } }],
  };
}

// A reservation lock serializes rate limits and concurrent activation exchanges.
export async function lockAppStay(tx: Prisma.TransactionClient, reservationId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${reservationId}, 0))`;
}

export async function requestOtaGuestAppActivation(
  prisma: PrismaClient,
  input: { guestToken: string; browserSecret: string; now?: Date },
  deliver: (input: { reservationId: string; challengeId: string; code: string }) => Promise<boolean>,
) {
  const now = input.now ?? new Date();
  if (!TOKEN.test(input.guestToken) || !TOKEN.test(input.browserSecret)) throw new GuestAppActivationError("UNAVAILABLE");
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const id = randomBytes(24).toString("base64url");
  const challenge = await prisma.$transaction(async tx => {
    const stay = await tx.reservation.findFirst({
      where: { guestToken: input.guestToken, ...activeAppStayWhere(now) },
      select: { id: true, source: true, externalProvider: true, externalId: true, checkOut: true, guestTokenExpiresAt: true },
    });
    if (!stay || !resolveChannexOperationalProvider(stay)) throw new GuestAppActivationError("UNAVAILABLE");
    await lockAppStay(tx, stay.id);
    const recent = await tx.guestAppActivationChallenge.count({
      where: { reservationId: stay.id, createdAt: { gt: new Date(now.getTime() - 3_600_000) } },
    });
    const cooldown = await tx.guestAppActivationChallenge.findFirst({
      where: { reservationId: stay.id, createdAt: { gt: new Date(now.getTime() - 60_000) } }, select: { id: true },
    });
    if (cooldown || recent >= 5) throw new GuestAppActivationError("RATE_LIMITED");
    return tx.guestAppActivationChallenge.create({ data: {
      id, reservationId: stay.id, guestTokenHash: activationHash(input.guestToken),
      browserHash: activationHash(input.browserSecret), codeHash: activationHash(`${id}:${code}:${input.browserSecret}`),
      createdAt: now, expiresAt: new Date(Math.min(now.getTime() + TEN_MINUTES, +stay.checkOut, +stay.guestTokenExpiresAt!)),
    } });
  });
  // No provider call inside a database transaction. Unknown acceptance is never retried.
  let accepted = false;
  try { accepted = await deliver({ reservationId: challenge.reservationId, challengeId: id, code }); } catch { /* static error below */ }
  if (!accepted) throw new GuestAppActivationError("DELIVERY_FAILED");
  await prisma.guestAppActivationChallenge.update({ where: { id }, data: { deliveredAt: now } });
  return { id, expiresAt: challenge.expiresAt };
}

export async function verifyOtaGuestAppActivation(
  prisma: PrismaClient,
  input: { challengeId: string; guestToken: string; browserSecret: string; code: string; now?: Date },
) {
  const now = input.now ?? new Date();
  if (!TOKEN.test(input.challengeId) || !TOKEN.test(input.browserSecret) || !TOKEN.test(input.guestToken))
    throw new GuestAppActivationError("INVALID_CODE");
  const activationToken = ACTIVATION_PREFIX + randomBytes(32).toString("base64url");
  const result = await prisma.$transaction(async tx => {
    const prior = await tx.guestAppActivationChallenge.findUnique({ where: { id: input.challengeId }, select: { reservationId: true } });
    if (!prior) return false;
    await lockAppStay(tx, prior.reservationId);
    const challenge = await tx.guestAppActivationChallenge.findUnique({ where: { id: input.challengeId } });
    if (!challenge || challenge.revokedAt || challenge.verifiedAt || challenge.consumedAt || !challenge.deliveredAt ||
        challenge.expiresAt <= now || challenge.attempts >= 5 ||
        challenge.browserHash !== activationHash(input.browserSecret) ||
        challenge.guestTokenHash !== activationHash(input.guestToken)) return false;
    const stay = await tx.reservation.findFirst({
      where: { id: challenge.reservationId, guestToken: input.guestToken, ...activeAppStayWhere(now) },
      select: { checkOut: true, guestTokenExpiresAt: true },
    });
    if (!stay) return false;
    // Commit failed attempts instead of throwing inside the transaction and rolling them back.
    await tx.guestAppActivationChallenge.update({ where: { id: challenge.id }, data: { attempts: { increment: 1 } } });
    if (!/^\d{6}$/.test(input.code) || challenge.codeHash !== activationHash(`${challenge.id}:${input.code}:${input.browserSecret}`)) return false;
    await tx.guestAppActivationChallenge.update({ where: { id: challenge.id }, data: {
      verifiedAt: now, activationTokenHash: activationHash(activationToken),
      activationExpiresAt: new Date(Math.min(now.getTime() + 120_000, +stay.checkOut, +stay.guestTokenExpiresAt!)),
    } });
    return true;
  });
  if (!result) throw new GuestAppActivationError("INVALID_CODE");
  return activationToken;
}
